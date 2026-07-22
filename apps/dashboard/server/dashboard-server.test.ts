import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createDashboardServer } from "./dashboard-server.js";

test("dashboard redirects retired ontology paths to their context-graph replacements", async (context) => {
  const server = createDashboardServer({ apiUrl: "http://127.0.0.1:9" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  );
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${baseUrl}/ontology`, { redirect: "manual" });
  assert.equal(page.status, 308);
  assert.equal(page.headers.get("location"), "/context-graph");

  const asset = await fetch(`${baseUrl}/assets/ontology-graph-client.js`, { redirect: "manual" });
  assert.equal(asset.status, 308);
  assert.equal(asset.headers.get("location"), "/assets/context-graph-client.js");

  const api = await fetch(`${baseUrl}/api/ontology/assertions?repository=omxyz%2Fjina`, { redirect: "manual" });
  assert.equal(api.status, 308);
  assert.equal(api.headers.get("location"), "/api/context-graph/assertions?repository=omxyz%2Fjina");

  const renamedPage = await fetch(`${baseUrl}/context-graph`);
  assert.equal(renamedPage.status, 200);
  assert.match(renamedPage.headers.get("content-type") ?? "", /text\/html/);

  const renamedAsset = await fetch(`${baseUrl}/assets/context-graph-client.js`);
  assert.equal(renamedAsset.status, 200);
  assert.match(renamedAsset.headers.get("content-type") ?? "", /text\/javascript/);
});
