import { getPool } from "./db.js";
import { rollbackInstallationTenantMove } from "./installation-tenant-transition.js";

const flags = new Set(process.argv.slice(2));
if (flags.has("--apply") === flags.has("--dry-run")) {
  throw new Error("pass exactly one of --dry-run or --apply");
}
const idIndex = process.argv.indexOf("--installation-id");
const installationId = Number(idIndex >= 0 ? process.argv[idIndex + 1] : undefined);
if (!Number.isSafeInteger(installationId) || installationId <= 0) {
  throw new Error("pass --installation-id with a positive GitHub installation id");
}

const pool = getPool();
const client = await pool.connect();
const mode = flags.has("--apply") ? "apply" : "dry-run";
try {
  await client.query("begin");
  await client.query("set local lock_timeout = '5s'");
  const result = await rollbackInstallationTenantMove(client, installationId, `cli:${mode}`);
  if (mode === "apply") {
    await client.query("commit");
  } else {
    await client.query("rollback");
  }
  console.log(JSON.stringify({ mode, githubInstallationId: installationId, ...result }));
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
