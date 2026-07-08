export function requireEnv(name: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
