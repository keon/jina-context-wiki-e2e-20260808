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
  return `"${role}"`;
}
