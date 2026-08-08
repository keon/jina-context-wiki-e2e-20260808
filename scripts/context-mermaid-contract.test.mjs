import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiPackage = JSON.parse(await readFile("apps/api/package.json", "utf8"));
const dashboardPackage = JSON.parse(await readFile("apps/dashboard/package.json", "utf8"));
const sharedContract = await readFile("packages/shared-kernel/src/mermaid-config.ts", "utf8");
const apiGenerator = await readFile("apps/api/src/context-wiki-execution.ts", "utf8");
const dashboardRenderer = await readFile("apps/dashboard/src/components/context/context-markdown.tsx", "utf8");
const lockfile = await readFile("pnpm-lock.yaml", "utf8");

const contractVersion = /contextMermaidVersion = "([^"]+)"/.exec(sharedContract)?.[1];

test("generation and browser rendering pin the exact shared Mermaid contract version", () => {
  assert.ok(contractVersion, "the shared Mermaid contract must declare a version");
  assert.equal(apiPackage.dependencies.mermaid, contractVersion);
  assert.equal(dashboardPackage.dependencies.mermaid, contractVersion);
  assert.match(apiGenerator, /contextMermaidConfig[\s\S]*contextMermaidVersion/);
  assert.match(dashboardRenderer, /contextMermaidConfig/);
  const escapedVersion = contractVersion.replaceAll(".", "\\.");
  assert.match(lockfile, new RegExp(`specifier: ['\"]?${escapedVersion}['\"]?\\n\\s+version: ${escapedVersion}`));
});
