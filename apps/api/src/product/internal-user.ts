import type pg from "pg";

export type GithubIdentityProfile = {
  githubUserId: number;
  githubLogin: string;
  displayName?: string | null;
  avatarUrl?: string;
};

export type InternalUserIdentity = {
  userId: string;
  personalTenantId: string;
};

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
      [user.rows[0]!.id, providerUserId, githubLogin],
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

  const userId = identity.rows[0]!.user_id;
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
  if (tenant.rows[0]!.kind !== "personal") {
    throw new Error(`GitHub user ${profile.githubUserId} is already bound to a team workspace`);
  }
  const personalTenantId = tenant.rows[0]!.id;

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
