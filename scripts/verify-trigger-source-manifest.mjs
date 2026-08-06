import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const triggerRoot = path.join(repositoryRoot, "trigger");
const manifestPath = path.join(triggerRoot, "source-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) {
  throw new Error("trigger/source-manifest.json has an unsupported schema");
}

const expected = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
const actualPaths = await filesBelow(triggerRoot);
for (const absolutePath of actualPaths) {
  const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
  const expectedDigest = expected.get(relativePath);
  if (!expectedDigest) throw new Error(`Trigger source manifest does not authorize ${relativePath}`);
  const digest = createHash("sha256")
    .update(await readFile(absolutePath))
    .digest("hex");
  if (digest !== expectedDigest) {
    throw new Error(`Trigger source mismatch for ${relativePath}: expected ${expectedDigest}, received ${digest}`);
  }
  expected.delete(relativePath);
}

if (expected.size > 0) {
  throw new Error(`Trigger source manifest files are missing: ${[...expected.keys()].sort().join(", ")}`);
}

for (const excluded of manifest.excluded_trigger_entrypoints ?? []) {
  if (
    actualPaths.some(
      (absolutePath) => path.relative(repositoryRoot, absolutePath).split(path.sep).join("/") === excluded
    )
  ) {
    throw new Error(`Review-only Trigger project contains excluded entrypoint ${excluded}`);
  }
}

process.stdout.write(
  `verified ${manifest.files.length} Trigger files from ${manifest.source_repository}@${manifest.source_commit}\n`
);

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".trigger") continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(absolutePath)));
    } else if (absolutePath !== manifestPath) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}
