export type DatabaseCutoverPhase = "prepare" | "finalize" | "verify";

export function databaseCutoverPhase(value: string | undefined): DatabaseCutoverPhase {
  if (value === "prepare" || value === "finalize" || value === "verify") return value;
  throw new Error("JINA_DATABASE_CUTOVER_PHASE must be prepare, finalize, or verify");
}

export function databaseRole(value: string | undefined, variable: string): string {
  const role = value?.trim();
  if (!role || !/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error(`${variable} must be a simple PostgreSQL role name`);
  }
  return role;
}

export function quoteRole(role: string): string {
  // Double embedded quotes so a role name can never break out of the identifier.
  // databaseRole() rejects exotic names, but quoteRole also quotes values read
  // back from the database (e.g. current_user), which skip that validation.
  return `"${role.replaceAll('"', '""')}"`;
}
