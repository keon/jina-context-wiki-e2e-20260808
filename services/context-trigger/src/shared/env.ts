const DEPLOYED_ENV_NAMES = [
  "API_BASE_URL",
  "CONTEXT_INTERNAL_API_TOKEN",
  "CONTEXT_WIKI_AUDIT_POLICY_VERSION",
  "CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST"
] as const;

export type ContextTriggerEnv = {
  apiBaseUrl: string;
  internalApiToken: string;
  auditPolicyVersion: string;
  auditorConfigDigest: string;
};

export function readContextTriggerEnv(env: NodeJS.ProcessEnv = process.env): ContextTriggerEnv {
  return {
    apiBaseUrl: parseApiBaseUrl(requiredEnv("API_BASE_URL", env)),
    internalApiToken: requiredEnv("CONTEXT_INTERNAL_API_TOKEN", env),
    auditPolicyVersion: boundedIdentifier(
      "CONTEXT_WIKI_AUDIT_POLICY_VERSION",
      requiredEnv("CONTEXT_WIKI_AUDIT_POLICY_VERSION", env)
    ),
    auditorConfigDigest: sha256Env(
      "CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST",
      requiredEnv("CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST", env)
    )
  };
}

export function resolveSyncedEnvVars(input: {
  manifestEnv: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const processEnv = input.processEnv ?? process.env;
  const output: Record<string, string> = {};
  for (const name of DEPLOYED_ENV_NAMES) {
    const raw = Object.hasOwn(processEnv, name) ? processEnv[name] : input.manifestEnv[name];
    if (typeof raw === "string" && raw.trim().length > 0) {
      output[name] = raw;
    }
  }
  return output;
}

function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  if (value.length > 8_192) {
    throw new Error(`Environment variable ${name} exceeds 8192 characters`);
  }
  return value;
}

function parseApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API_BASE_URL must use HTTP(S)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API_BASE_URL must not contain credentials, query parameters, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function boundedIdentifier(name: string, raw: string): string {
  if (raw.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) {
    throw new Error(`${name} must be a 1-128 character identifier`);
  }
  return raw;
}

function sha256Env(name: string, raw: string): string {
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return raw;
}
