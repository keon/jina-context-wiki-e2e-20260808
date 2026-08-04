import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "./server.js";

test("the Jina listener serves absorbed product routes without entering Context auth", async () => {
  const seen: string[] = [];
  const server = createApiServer({
    productApiRequestHandler(request, response) {
      seen.push(request.url ?? "");
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", component: "product" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/dashboard/me`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", component: "product" });
    assert.deepEqual(seen, ["/dashboard/me"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
