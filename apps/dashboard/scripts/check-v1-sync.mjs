import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mirrorRoot = resolve(packageRoot, "src/v1");
const vendoredRoot = resolve(packageRoot, "../../platform/v1/dashboard/app");

const mirror = await fingerprints(mirrorRoot);
const vendored = await fingerprints(vendoredRoot);
const allPaths = [...new Set([...mirror.keys(), ...vendored.keys()])].sort();
const mismatches = allPaths.filter((path) => mirror.get(path) !== vendored.get(path));

if (mismatches.length > 0) {
  console.error("The compiled v1 dashboard mirror differs from platform/v1/dashboard/app:");
  for (const path of mismatches) console.error(`  - ${path}`);
  console.error("Refresh both trees together before shipping.");
  process.exitCode = 1;
}

async function fingerprints(root) {
  const result = new Map();
  await visit(root);
  return result;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        result.set(relative(root, path), createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
}
