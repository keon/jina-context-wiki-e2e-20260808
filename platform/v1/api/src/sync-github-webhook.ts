import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type NgrokTunnel = {
  public_url?: string;
  config?: {
    addr?: string;
  };
};

type NgrokResponse = {
  tunnels?: NgrokTunnel[];
};

type GithubHookConfig = {
  url?: string;
  content_type?: string;
  insecure_ssl?: string;
};

loadDotEnv(resolve(process.cwd(), "../.env"));
loadDotEnv(resolve(process.cwd(), ".env"));

const webhookUrl = await resolveWebhookUrl();
const jwt = createGithubAppJwt(requiredEnv("GITHUB_APP_ID"), normalizePrivateKey(requiredEnv("GITHUB_APP_PRIVATE_KEY")));

const response = await fetch("https://api.github.com/app/hook/config", {
  method: "PATCH",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  },
  body: JSON.stringify({
    url: webhookUrl,
    content_type: "json",
    secret: requiredEnv("GITHUB_WEBHOOK_SECRET"),
    insecure_ssl: "0",
  }),
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`GitHub webhook sync failed: ${response.status} ${response.statusText} ${body}`);
}

const config = (await response.json()) as GithubHookConfig;
console.log(
  JSON.stringify(
    {
      url: config.url,
      content_type: config.content_type,
      insecure_ssl: config.insecure_ssl,
    },
    null,
    2,
  ),
);

async function resolveWebhookUrl(): Promise<string> {
  const configuredUrl = optionalEnv("WEBHOOK_PUBLIC_URL");
  const publicOrigin = configuredUrl ?? (await discoverNgrokOrigin());
  const webhookPath = optionalEnv("GITHUB_WEBHOOK_PATH") ?? "/webhooks/github";

  if (publicOrigin.endsWith(webhookPath)) {
    return publicOrigin;
  }

  const base = publicOrigin.endsWith("/") ? publicOrigin : `${publicOrigin}/`;
  return new URL(webhookPath.replace(/^\//, ""), base).toString();
}

async function discoverNgrokOrigin(): Promise<string> {
  const ngrokApiUrl = optionalEnv("NGROK_API_URL") ?? "http://127.0.0.1:4040/api/tunnels";
  const response = await fetch(ngrokApiUrl);
  if (!response.ok) {
    throw new Error(`Unable to read ngrok tunnels from ${ngrokApiUrl}: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as NgrokResponse;
  const tunnels = payload.tunnels ?? [];
  const port = optionalEnv("PORT") ?? "8080";
  const targetAddrs = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

  const matchingTunnel =
    tunnels.find((tunnel) => tunnel.public_url?.startsWith("https://") && targetAddrs.has(tunnel.config?.addr ?? "")) ??
    tunnels.find((tunnel) => tunnel.public_url?.startsWith("https://"));

  if (!matchingTunnel?.public_url) {
    throw new Error(`No HTTPS ngrok tunnel found at ${ngrokApiUrl}. Run "ngrok http ${port}" or set WEBHOOK_PUBLIC_URL.`);
  }

  return matchingTunnel.public_url;
}

function createGithubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);

  return `${signingInput}.${base64Url(signature)}`;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (process.env[key]) {
      continue;
    }

    let rawValue = line.slice(equalsIndex + 1).trimStart();
    const quote = rawValue[0];
    if ((quote === `"` || quote === `'`) && !hasClosingQuote(rawValue, quote)) {
      while (index + 1 < lines.length) {
        index += 1;
        rawValue += `\n${lines[index]}`;
        if (hasClosingQuote(lines[index].trimEnd(), quote)) {
          break;
        }
      }
    }

    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function hasClosingQuote(value: string, quote: string): boolean {
  return value.length > 1 && value.endsWith(quote);
}

function unquoteEnvValue(value: string): string {
  const quote = value[0];
  const isQuoted = (quote === `"` || quote === `'`) && value[value.length - 1] === quote;
  return isQuoted ? value.slice(1, -1) : value;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}
