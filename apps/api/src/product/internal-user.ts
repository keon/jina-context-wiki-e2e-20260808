import type pg from "pg";

export interface GithubIdentityProfile {
  githubUserId: number;
  githubLogin: string;
}

export interface InternalUserIdentity {
  userId: string;
  personalTenantId: string;
}

export interface ClerkIdentityProfile {
  clerkUserId: string;
  userId: string;
  providerLogin?: string | null;
}

export interface ClerkIdentityBindResult {
  userId: string;
  /** Stale projections replaced to match Clerk, for observability. */
  replacedClerkUserId?: string;
  replacedUserId?: string;
}

export type GithubAdoptionResult =
  | { status: "adopted" | "already-owned" }
  | { status: "owned-elsewhere"; ownerUserId: string };

/**
 * Resolve a GitHub login to one durable Jina user and one personal workspace.
 *
 * The caller owns the transaction. The per-provider advisory lock closes the
 * first-login race without introducing a separate identity service.
 */
export async function upsertGithubUserIdentity(
  client: Pick<pg.PoolClient, "query">,
  profile: GithubIdentityProfile,
): Promise<InternalUserIdentity> {
  if (!Number.isSafeInteger(profile.githubUserId) || profile.githubUserId <= 0) {
    throw new Error("GitHub user id must be a positive safe integer");
  }
  const githubLogin = profile.githubLogin.trim();
  if (!githubLogin) {
    throw new Error("GitHub login is required");
  }
  const providerUserId = String(profile.githubUserId);

  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('github:' || $1::text, 0))",
    [providerUserId],
  );

  let identity = await client.query<{ user_id: string }>(
    `select user_id
       from user_identities
      where provider = 'github' and provider_user_id = $1`,
    [providerUserId],
  );

  if (!identity.rows[0]) {
    const user = await client.query<{ id: string }>(
      `insert into users default values
       returning id`,
    );
    identity = await client.query<{ user_id: string }>(
      `insert into user_identities (user_id, provider, provider_user_id, provider_login)
       values ($1, 'github', $2, $3)
       returning user_id`,
      [user.rows[0].id, providerUserId, githubLogin],
    );
  } else {
    await client.query(
      `update user_identities
          set provider_login = $2, updated_at = now()
        where provider = 'github' and provider_user_id = $1`,
      [providerUserId, githubLogin],
    );
  }

  const userId = identity.rows[0].user_id;
  const tenant = await client.query<{ id: string; kind: string | null }>(
    `insert into tenants
       (github_account_id, github_account_login, github_account_type, kind, name, personal_owner_user_id)
     values ($1, $2, 'User', 'personal', $2, $3)
     on conflict (github_account_id) do update set
       github_account_login = excluded.github_account_login,
       github_account_type = 'User',
       kind = coalesce(tenants.kind, 'personal'),
       name = case
         when tenants.name is null or tenants.name = tenants.github_account_login then excluded.name
         else tenants.name
       end,
       personal_owner_user_id = case
         when coalesce(tenants.kind, 'personal') = 'personal' then excluded.personal_owner_user_id
         else tenants.personal_owner_user_id
       end
     returning id, kind`,
    [profile.githubUserId, githubLogin, userId],
  );
  if (tenant.rows[0].kind !== "personal") {
    throw new Error(`GitHub user ${profile.githubUserId} is already bound to a team workspace`);
  }
  const personalTenantId = tenant.rows[0].id;

  return { userId, personalTenantId };
}

/**
 * Make the database's Clerk projection match Clerk.
 *
 * Clerk owns identity: its unique `external_id` names the Jina user, and the
 * caller verifies against Clerk that no other Clerk account holds this user
 * before binding. Rows here are projections, so a row that disagrees with
 * Clerk is stale by definition and is replaced rather than defended.
 */
export async function bindClerkUserIdentity(
  client: Pick<pg.PoolClient, "query">,
  profile: ClerkIdentityProfile,
): Promise<ClerkIdentityBindResult> {
  const clerkUserId = profile.clerkUserId.trim();
  const userId = profile.userId.trim();
  const providerLogin = profile.providerLogin?.trim() || null;
  if (!clerkUserId) throw new Error("Clerk user id is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("Stable Jina user id must be a UUID");
  }

  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('clerk:' || $1::text, 0))",
    [clerkUserId],
  );
  await client.query("select id from users where id = $1::uuid for update", [userId]);

  const result: ClerkIdentityBindResult = { userId };

  const staleByUser = await client.query<{ provider_user_id: string }>(
    `delete from user_identities
      where provider = 'clerk' and user_id = $1::uuid and provider_user_id <> $2
      returning provider_user_id`,
    [userId, clerkUserId],
  );
  if (staleByUser.rows[0]) result.replacedClerkUserId = staleByUser.rows[0].provider_user_id;

  const rebound = await client.query<{ user_id: string }>(
    `select user_id from user_identities
      where provider = 'clerk' and provider_user_id = $1 and user_id <> $2::uuid`,
    [clerkUserId, userId],
  );
  if (rebound.rows[0]) result.replacedUserId = rebound.rows[0].user_id;

  await client.query(
    `insert into user_identities (user_id, provider, provider_user_id, provider_login)
     values ($1::uuid, 'clerk', $2, $3)
     on conflict (provider, provider_user_id)
       do update set user_id = excluded.user_id,
                     provider_login = coalesce(excluded.provider_login, user_identities.provider_login),
                     updated_at = now()`,
    [userId, clerkUserId, providerLogin],
  );
  return result;
}

/** The GitHub identity recorded for a Jina user, if any. */
export async function githubIdentityForUser(
  client: Pick<pg.PoolClient, "query">,
  userId: string,
): Promise<{ githubUserId: number; githubLogin: string } | undefined> {
  const row = await client.query<{ provider_user_id: string; provider_login: string | null }>(
    `select provider_user_id, provider_login
       from user_identities
      where provider = 'github' and user_id = $1::uuid`,
    [userId],
  );
  if (!row.rows[0]) return undefined;
  const githubUserId = Number(row.rows[0].provider_user_id);
  const githubLogin = row.rows[0].provider_login ?? "";
  if (!Number.isSafeInteger(githubUserId) || !githubLogin) return undefined;
  return { githubUserId, githubLogin };
}

/**
 * Record an unclaimed GitHub identity for a Clerk-resolved user. GitHub
 * attribution stays append-only: an identity already owned by another user is
 * reported, never moved, because review and billing history hang off it.
 */
export async function adoptGithubIdentity(
  client: Pick<pg.PoolClient, "query">,
  input: { userId: string; githubUserId: number; githubLogin: string },
): Promise<GithubAdoptionResult> {
  const providerUserId = String(input.githubUserId);
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('github:' || $1::text, 0))",
    [providerUserId],
  );
  const existing = await client.query<{ user_id: string }>(
    `select user_id from user_identities
      where provider = 'github' and provider_user_id = $1`,
    [providerUserId],
  );
  if (existing.rows[0]) {
    return existing.rows[0].user_id === input.userId
      ? { status: "already-owned" }
      : { status: "owned-elsewhere", ownerUserId: existing.rows[0].user_id };
  }
  await client.query(
    `insert into user_identities (user_id, provider, provider_user_id, provider_login)
     values ($1::uuid, 'github', $2, $3)`,
    [input.userId, providerUserId, input.githubLogin],
  );
  return { status: "adopted" };
}
