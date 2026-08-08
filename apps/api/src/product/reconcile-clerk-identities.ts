import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClerkClient } from "@clerk/backend";

import { getPool } from "./db.js";
import { linkClerkUserIdentity } from "./internal-user.js";

interface UserMapping {
  clerkUserId: string;
  githubUserId: number;
  githubLogin?: string;
  /** Required for an explicit operator-approved mapping when Clerk has no GitHub account yet. */
  allowMissingClerkGithubAccount?: boolean;
}

interface OrganizationMapping {
  clerkOrganizationId: string;
  jinaTenantId: string;
  expectedJinaName?: string;
  expectedClerkName?: string;
}

interface MembershipMapping {
  clerkOrganizationId: string;
  clerkUserId: string;
  role: "org:admin" | "org:member";
}

interface ReconciliationManifest {
  version: 1;
  users: UserMapping[];
  organizations: OrganizationMapping[];
  memberships: MembershipMapping[];
}

interface ResolvedUser extends UserMapping {
  jinaUserId: string;
  providerLogin: string | null;
  writeDatabaseLink: boolean;
  writeClerkExternalId: boolean;
}

interface ResolvedOrganization extends OrganizationMapping {
  writeDatabaseLink: boolean;
  writeClerkMetadata: boolean;
}

interface ResolvedMembership extends MembershipMapping {
  action: "none" | "create" | "update";
}

loadDotEnv(resolve(process.cwd(), "../.env"));
loadDotEnv(resolve(process.cwd(), ".env"));

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const apply = args.includes("--apply");
const dryRun = args.includes("--dry-run");
if (apply === dryRun) throw new Error("pass exactly one of --dry-run or --apply");
const manifestArgument = args.find((argument) => argument.startsWith("--manifest="));
if (!manifestArgument) throw new Error("pass --manifest=/absolute/path/to/clerk-mapping.json");
for (const argument of args) {
  if (argument !== "--apply" && argument !== "--dry-run" && !argument.startsWith("--manifest=")) {
    throw new Error(`unsupported argument: ${argument}`);
  }
}

const manifestPath = resolve(manifestArgument.slice("--manifest=".length));
const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
const clerkSecretKey = requiredEnv("CLERK_SECRET_KEY");
const clerkPublishableKey = requiredEnv("CLERK_PUBLISHABLE_KEY");
const clerk = createClerkClient({
  secretKey: clerkSecretKey,
  publishableKey: clerkPublishableKey,
  telemetry: { disabled: true },
});
const pool = getPool();
const client = await pool.connect();

const blockers: string[] = [];
const resolvedUsers: ResolvedUser[] = [];
const resolvedOrganizations: ResolvedOrganization[] = [];
const resolvedMemberships: ResolvedMembership[] = [];

try {
  for (const mapping of manifest.users) {
    const githubIdentity = await client.query<{
      user_id: string;
      provider_login: string | null;
    }>(
      `select user_id, provider_login
         from user_identities
        where provider = 'github' and provider_user_id = $1`,
      [String(mapping.githubUserId)],
    );
    if (!githubIdentity.rows[0]) {
      blockers.push(`GitHub user ${mapping.githubUserId} has no stable Jina identity`);
      continue;
    }
    const jinaUserId = githubIdentity.rows[0].user_id;
    if (
      mapping.githubLogin
      && githubIdentity.rows[0].provider_login?.toLowerCase() !== mapping.githubLogin.toLowerCase()
    ) {
      blockers.push(
        `GitHub user ${mapping.githubUserId} login is ${githubIdentity.rows[0].provider_login ?? "missing"}, not ${mapping.githubLogin}`,
      );
      continue;
    }

    const existingClerkIdentities = await client.query<{
      user_id: string;
      provider_user_id: string;
    }>(
      `select user_id, provider_user_id
         from user_identities
        where provider = 'clerk'
          and (provider_user_id = $1 or user_id = $2::uuid)`,
      [mapping.clerkUserId, jinaUserId],
    );
    if (
      existingClerkIdentities.rows.some(
        (identity) => identity.user_id !== jinaUserId || identity.provider_user_id !== mapping.clerkUserId,
      )
    ) {
      blockers.push(`Clerk user ${mapping.clerkUserId} conflicts with an existing Jina identity link`);
      continue;
    }

    const clerkUser = await clerk.users.getUser(mapping.clerkUserId);
    const clerkGithub = clerkUser.externalAccounts.find((account) => account.provider === "oauth_github");
    if (clerkGithub && clerkGithub.externalId !== String(mapping.githubUserId)) {
      blockers.push(
        `Clerk user ${mapping.clerkUserId} has GitHub id ${clerkGithub.externalId}, not ${mapping.githubUserId}`,
      );
      continue;
    }
    if (!clerkGithub && !mapping.allowMissingClerkGithubAccount) {
      blockers.push(
        `Clerk user ${mapping.clerkUserId} has no GitHub account; require explicit allowMissingClerkGithubAccount`,
      );
      continue;
    }
    if (clerkUser.externalId && clerkUser.externalId !== jinaUserId) {
      blockers.push(
        `Clerk user ${mapping.clerkUserId} externalId ${clerkUser.externalId} conflicts with Jina user ${jinaUserId}`,
      );
      continue;
    }
    const email = clerkUser.primaryEmailAddressId
      ? clerkUser.emailAddresses.find((candidate) => candidate.id === clerkUser.primaryEmailAddressId)?.emailAddress ?? null
      : clerkUser.emailAddresses[0]?.emailAddress ?? null;
    resolvedUsers.push({
      ...mapping,
      jinaUserId,
      providerLogin: email,
      writeDatabaseLink: existingClerkIdentities.rowCount === 0,
      writeClerkExternalId: !clerkUser.externalId,
    });
  }

  for (const mapping of manifest.organizations) {
    const tenant = await client.query<{
      name: string | null;
      kind: string | null;
      clerk_organization_id: string | null;
    }>(
      `select name, kind, clerk_organization_id
         from tenants
        where id = $1::uuid and merged_into_tenant_id is null`,
      [mapping.jinaTenantId],
    );
    if (!tenant.rows[0]) {
      blockers.push(`Jina tenant ${mapping.jinaTenantId} does not exist or was merged`);
      continue;
    }
    if (tenant.rows[0].kind !== "team") {
      blockers.push(`Jina tenant ${mapping.jinaTenantId} is not a team workspace`);
      continue;
    }
    if (mapping.expectedJinaName && tenant.rows[0].name !== mapping.expectedJinaName) {
      blockers.push(
        `Jina tenant ${mapping.jinaTenantId} name is ${tenant.rows[0].name ?? "missing"}, not ${mapping.expectedJinaName}`,
      );
      continue;
    }
    if (
      tenant.rows[0].clerk_organization_id
      && tenant.rows[0].clerk_organization_id !== mapping.clerkOrganizationId
    ) {
      blockers.push(
        `Jina tenant ${mapping.jinaTenantId} is already linked to ${tenant.rows[0].clerk_organization_id}`,
      );
      continue;
    }
    const otherTenant = await client.query<{ id: string }>(
      `select id
         from tenants
        where clerk_organization_id = $1 and id <> $2::uuid`,
      [mapping.clerkOrganizationId, mapping.jinaTenantId],
    );
    if (otherTenant.rows[0]) {
      blockers.push(
        `Clerk organization ${mapping.clerkOrganizationId} is already linked to tenant ${otherTenant.rows[0].id}`,
      );
      continue;
    }

    const clerkOrganization = await clerk.organizations.getOrganization({
      organizationId: mapping.clerkOrganizationId,
    });
    if (mapping.expectedClerkName && clerkOrganization.name !== mapping.expectedClerkName) {
      blockers.push(
        `Clerk organization ${mapping.clerkOrganizationId} name is ${clerkOrganization.name}, not ${mapping.expectedClerkName}`,
      );
      continue;
    }
    const metadataTenantId = metadataString(clerkOrganization.privateMetadata, "jinaTenantId");
    if (metadataTenantId && metadataTenantId !== mapping.jinaTenantId) {
      blockers.push(
        `Clerk organization ${mapping.clerkOrganizationId} metadata points to tenant ${metadataTenantId}`,
      );
      continue;
    }
    resolvedOrganizations.push({
      ...mapping,
      writeDatabaseLink: !tenant.rows[0].clerk_organization_id,
      writeClerkMetadata: !metadataTenantId,
    });
  }

  const mappedUserIds = new Set(manifest.users.map((mapping) => mapping.clerkUserId));
  const mappedOrganizationIds = new Set(
    manifest.organizations.map((mapping) => mapping.clerkOrganizationId),
  );
  for (const mapping of manifest.memberships) {
    if (!mappedUserIds.has(mapping.clerkUserId)) {
      blockers.push(`Membership references unmapped Clerk user ${mapping.clerkUserId}`);
      continue;
    }
    if (!mappedOrganizationIds.has(mapping.clerkOrganizationId)) {
      blockers.push(`Membership references unmapped Clerk organization ${mapping.clerkOrganizationId}`);
      continue;
    }
    const memberships = await clerk.organizations.getOrganizationMembershipList({
      organizationId: mapping.clerkOrganizationId,
      userId: [mapping.clerkUserId],
      limit: 10,
    });
    const existing = memberships.data.find(
      (membership) => membership.publicUserData?.userId === mapping.clerkUserId,
    );
    resolvedMemberships.push({
      ...mapping,
      action: existing ? (existing.role === mapping.role ? "none" : "update") : "create",
    });
  }

  const report = {
    mode: apply ? "apply" : "dry-run",
    manifest: manifestPath,
    converged: blockers.length === 0,
    blockers,
    users: resolvedUsers.map((user) => ({
      clerkUserId: user.clerkUserId,
      githubUserId: user.githubUserId,
      jinaUserId: user.jinaUserId,
      database: user.writeDatabaseLink ? "link" : "already-linked",
      clerkExternalId: user.writeClerkExternalId ? "set" : "already-set",
    })),
    organizations: resolvedOrganizations.map((organization) => ({
      clerkOrganizationId: organization.clerkOrganizationId,
      jinaTenantId: organization.jinaTenantId,
      database: organization.writeDatabaseLink ? "link" : "already-linked",
      clerkMetadata: organization.writeClerkMetadata ? "set" : "already-set",
    })),
    memberships: resolvedMemberships,
  };

  if (blockers.length > 0) {
    console.error(JSON.stringify(report));
    throw new Error("Clerk identity reconciliation has blockers; no changes were applied");
  }
  if (!apply) {
    console.log(JSON.stringify(report));
  } else {
    // Provider writes are idempotent and happen before the DB transaction. If a
    // later DB write fails, the runtime still ignores unlinked Clerk resources;
    // rerunning the same manifest safely completes the operation.
    for (const user of resolvedUsers) {
      if (user.writeClerkExternalId) {
        await clerk.users.updateUser(user.clerkUserId, { externalId: user.jinaUserId });
      }
    }
    for (const organization of resolvedOrganizations) {
      if (organization.writeClerkMetadata) {
        await clerk.organizations.updateOrganizationMetadata(organization.clerkOrganizationId, {
          privateMetadata: { jinaTenantId: organization.jinaTenantId },
        });
      }
    }
    for (const membership of resolvedMemberships) {
      if (membership.action === "create") {
        await clerk.organizations.createOrganizationMembership({
          organizationId: membership.clerkOrganizationId,
          userId: membership.clerkUserId,
          role: membership.role,
        });
      } else if (membership.action === "update") {
        await clerk.organizations.updateOrganizationMembership({
          organizationId: membership.clerkOrganizationId,
          userId: membership.clerkUserId,
          role: membership.role,
        });
      }
    }

    await client.query("begin");
    try {
      await client.query("set local lock_timeout = '5s'");
      await client.query("set local statement_timeout = '5min'");
      for (const user of resolvedUsers) {
        const result = await linkClerkUserIdentity(client, {
          clerkUserId: user.clerkUserId,
          userId: user.jinaUserId,
          providerLogin: user.providerLogin,
        });
        if (result.status === "conflict") {
          throw new Error(`Clerk user ${user.clerkUserId} became conflicting during apply`);
        }
      }
      for (const organization of resolvedOrganizations) {
        const linked = await client.query(
          `update tenants
              set clerk_organization_id = $2
            where id = $1::uuid
              and merged_into_tenant_id is null
              and (clerk_organization_id is null or clerk_organization_id = $2)`,
          [organization.jinaTenantId, organization.clerkOrganizationId],
        );
        if (linked.rowCount !== 1) {
          throw new Error(`Jina tenant ${organization.jinaTenantId} became conflicting during apply`);
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    console.log(JSON.stringify({ ...report, applied: true }));
  }
} finally {
  client.release();
  await pool.end();
}

function parseManifest(raw: unknown): ReconciliationManifest {
  if (!raw || typeof raw !== "object") throw new Error("manifest must be a JSON object");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) throw new Error("manifest.version must be 1");
  const users = array(value.users, "manifest.users").map((entry, index) => {
    const item = record(entry, `manifest.users[${index}]`);
    const githubUserId = Number(item.githubUserId);
    if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
      throw new Error(`manifest.users[${index}].githubUserId must be a positive safe integer`);
    }
    return {
      clerkUserId: string(item.clerkUserId, `manifest.users[${index}].clerkUserId`),
      githubUserId,
      ...(optionalString(item.githubLogin) ? { githubLogin: optionalString(item.githubLogin) } : {}),
      ...(item.allowMissingClerkGithubAccount === true ? { allowMissingClerkGithubAccount: true } : {}),
    };
  });
  const organizations = array(value.organizations, "manifest.organizations").map((entry, index) => {
    const item = record(entry, `manifest.organizations[${index}]`);
    return {
      clerkOrganizationId: string(
        item.clerkOrganizationId,
        `manifest.organizations[${index}].clerkOrganizationId`,
      ),
      jinaTenantId: uuid(item.jinaTenantId, `manifest.organizations[${index}].jinaTenantId`),
      ...(optionalString(item.expectedJinaName) ? { expectedJinaName: optionalString(item.expectedJinaName) } : {}),
      ...(optionalString(item.expectedClerkName) ? { expectedClerkName: optionalString(item.expectedClerkName) } : {}),
    };
  });
  const memberships = array(value.memberships, "manifest.memberships").map((entry, index) => {
    const item = record(entry, `manifest.memberships[${index}]`);
    const role = string(item.role, `manifest.memberships[${index}].role`);
    if (role !== "org:admin" && role !== "org:member") {
      throw new Error(`manifest.memberships[${index}].role must be org:admin or org:member`);
    }
    const membershipRole: MembershipMapping["role"] = role;
    return {
      clerkOrganizationId: string(
        item.clerkOrganizationId,
        `manifest.memberships[${index}].clerkOrganizationId`,
      ),
      clerkUserId: string(item.clerkUserId, `manifest.memberships[${index}].clerkUserId`),
      role: membershipRole,
    };
  });
  unique(users.map((mapping) => mapping.clerkUserId), "Clerk user mapping");
  unique(users.map((mapping) => String(mapping.githubUserId)), "GitHub user mapping");
  unique(organizations.map((mapping) => mapping.clerkOrganizationId), "Clerk organization mapping");
  unique(organizations.map((mapping) => mapping.jinaTenantId), "Jina tenant mapping");
  unique(
    memberships.map((mapping) => `${mapping.clerkOrganizationId}:${mapping.clerkUserId}`),
    "Clerk membership mapping",
  );
  return { version: 1, users, organizations, memberships };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uuid(value: unknown, name: string): string {
  const normalized = string(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`${name} must be a UUID`);
  }
  return normalized;
}

function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} entries must be unique`);
}

function metadataString(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  return optionalString((metadata as Record<string, unknown>)[key]);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    if (process.env[key]) continue;
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
