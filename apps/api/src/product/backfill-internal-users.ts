import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getPool } from "./db.js";
import { runInternalUserTransition } from "./identity-transition.js";
import { resolveRepositoryInstallations } from "./resolve-repository-installations.js";

loadDotEnv(resolve(process.cwd(), "../.env"));
loadDotEnv(resolve(process.cwd(), ".env"));

const flags = new Set(process.argv.slice(2));
if (flags.has("--apply") === flags.has("--dry-run")) {
  throw new Error("pass exactly one of --dry-run or --apply");
}
const supportedFlags = new Set([
  "--apply",
  "--dry-run",
  "--require-converged",
  "--resolve-repositories",
]);
for (const flag of flags) {
  if (!supportedFlags.has(flag)) {
    throw new Error(`unsupported flag: ${flag}`);
  }
}

const mode = flags.has("--apply") ? "apply" : "dry-run";
const pool = getPool();
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '5min'");
  const repositoryResolution = flags.has("--resolve-repositories")
    ? await resolveRepositoryInstallations(client)
    : undefined;
  const report = await runInternalUserTransition(client);
  const unresolved = {
    identities: report.unmappedIdentities,
    enabledRepositoriesWithoutExactInstallation: report.unmappedRepositories,
  };
  if (flags.has("--require-converged") && Object.values(unresolved).some((count) => count > 0)) {
    console.error(JSON.stringify({ mode, converged: false, unresolved, repositoryResolution, ...report }));
    throw new Error("identity transition did not converge; no changes were committed");
  }
  if (mode === "apply") {
    await client.query("commit");
  } else {
    await client.query("rollback");
  }
  console.log(JSON.stringify({ mode, converged: true, repositoryResolution, ...report }));
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
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
