import type pg from "pg";

export interface GithubIdentityProfile {
  githubUserId: number;
  githubLogin: string;
  displayName?: string | null;
  avatarUrl?: string;
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

export type ClerkIdentityLinkResult =
  | { status: "linked" | "already-linked"; userId: string }
  | { status: "conflict"; userId: string };

export const INTERNAL_USER_TRANSITION_LOCK_KEY = 8231440072026;

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
  const displayName = profile.displayName?.trim() || githubLogin;
  const avatarUrl = profile.avatarUrl?.trim() || null;

  // Live identity writes share this lock with each other, while the one-off
  // transition takes it exclusively. That lets normal logins remain
  // concurrent but prevents a backfill from racing a first login.
  await client.query("select pg_advisory_xact_lock_shared($1)", [
    INTERNAL_USER_TRANSITION_LOCK_KEY,
  ]);
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
      `insert into users (display_name, avatar_url)
       values ($1, $2)
       returning id`,
      [displayName, avatarUrl],
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
    await client.query(
      `update users
          set display_name = $2, avatar_url = coalesce($3, avatar_url), updated_at = now()
        where id = $1`,
      [identity.rows[0].user_id, displayName, avatarUrl],
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

  // Catch up rows written by a previous application revision or by a GitHub
  // installation webhook before the installer first signs in.
  await client.query(
    `update tenant_members
        set user_id = $2, github_login = $3
      where github_user_id = $1
        and (user_id is distinct from $2 or github_login is distinct from $3)`,
    [profile.githubUserId, userId, githubLogin],
  );
  await client.query(
    `update user_integrations
        set user_id = $2, github_login = coalesce($3, github_login), updated_at = now()
      where github_user_id = $1
        and (user_id is distinct from $2 or github_login is distinct from coalesce($3, github_login))`,
    [profile.githubUserId, userId, githubLogin],
  );
  await client.query(
    `insert into tenant_members
       (tenant_id, github_user_id, github_login, user_id, role, source, synced_at)
     values ($1, $2, $3, $4, 'admin', 'oauth', now())
     on conflict (tenant_id, github_user_id) do update set
       github_login = excluded.github_login,
       user_id = excluded.user_id,
       role = 'admin',
       synced_at = now()`,
    [personalTenantId, profile.githubUserId, githubLogin, userId],
  );

  return { userId, personalTenantId };
}

/**
 * Attach one Clerk principal to an already-resolved stable Jina user.
 *
 * GitHub's immutable numeric id resolves the Jina user before this function is
 * called. We never merge by display name or email here. Both directions are
 * unique, and conflicts are returned without modifying either identity.
 */
export async function linkClerkUserIdentity(
  client: Pick<pg.PoolClient, "query">,
  profile: ClerkIdentityProfile,
): Promise<ClerkIdentityLinkResult> {
  const clerkUserId = profile.clerkUserId.trim();
  const userId = profile.userId.trim();
  const providerLogin = profile.providerLogin?.trim() || null;
  if (!clerkUserId) throw new Error("Clerk user id is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("Stable Jina user id must be a UUID");
  }

  await client.query("select pg_advisory_xact_lock_shared($1)", [
    INTERNAL_USER_TRANSITION_LOCK_KEY,
  ]);
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('clerk:' || $1::text, 0))",
    [clerkUserId],
  );
  await client.query("select id from users where id = $1::uuid for update", [userId]);

  const byClerk = await client.query<{ user_id: string }>(
    `select user_id
       from user_identities
      where provider = 'clerk' and provider_user_id = $1`,
    [clerkUserId],
  );
  if (byClerk.rows[0] && byClerk.rows[0].user_id !== userId) {
    return { status: "conflict", userId: byClerk.rows[0].user_id };
  }

  const byUser = await client.query<{ provider_user_id: string }>(
    `select provider_user_id
       from user_identities
      where provider = 'clerk' and user_id = $1::uuid`,
    [userId],
  );
  if (byUser.rows[0] && byUser.rows[0].provider_user_id !== clerkUserId) {
    return { status: "conflict", userId };
  }

  if (byClerk.rows[0]) {
    await client.query(
      `update user_identities
          set provider_login = coalesce($3, provider_login), updated_at = now()
        where provider = 'clerk' and provider_user_id = $1 and user_id = $2::uuid`,
      [clerkUserId, userId, providerLogin],
    );
    return { status: "already-linked", userId };
  }

  await client.query(
    `insert into user_identities (user_id, provider, provider_user_id, provider_login)
     values ($1::uuid, 'clerk', $2, $3)`,
    [userId, clerkUserId, providerLogin],
  );
  return { status: "linked", userId };
}
