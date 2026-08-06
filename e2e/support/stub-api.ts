/**
 * A stand-in for the Jina API, so the admin console can be driven end to end
 * with no backend, no database and no credentials.
 *
 * The console is a read-only projection of five API reads. Pointing
 * `JINA_API_URL` at this process is therefore the whole integration: `next dev`
 * renders the real server components, against real responses, and a real browser
 * lays the result out.
 *
 * A single process serves every scenario. `POST /__scenario/<name>` switches
 * which set of answers is in force; the admin page is `force-dynamic` and reads
 * with `cache: "no-store"`, so the next navigation re-reads everything. That is
 * why the admin project runs with one worker: the scenario is server state, and
 * two tests holding different opinions about it would race.
 *
 * Run directly (`node e2e/support/stub-api.ts`); Playwright starts it as a
 * `webServer`. `STUB_API_PORT` overrides the port.
 */

import { createServer } from "node:http";
import { isScenario, replyFor, type Scenario } from "./fixtures.ts";

const PORT = Number(process.env.STUB_API_PORT ?? 4310);

let scenario: Scenario = "partial";

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://stub.invalid");

  // Readiness. Playwright polls this before it starts the admin server, so the
  // first render cannot race the stub's own startup into a false "degraded".
  if (url.pathname === "/__health") return json(response, 200, { ok: true, scenario });

  if (url.pathname.startsWith("/__scenario/") && request.method === "POST") {
    const requested = url.pathname.slice("/__scenario/".length);
    if (!isScenario(requested)) return json(response, 400, { error: `unknown scenario: ${requested}` });
    scenario = requested;
    return json(response, 200, { scenario });
  }

  const reply = replyFor(scenario, url.pathname, url.searchParams);
  if (!reply) return json(response, 404, { error: `stub has no answer for ${url.pathname}` });
  return json(response, reply.status, reply.body);
});

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    // Nothing between the console and this process may hold an answer: a cached
    // response would survive a scenario switch and fail the next test instead.
    "cache-control": "no-store"
  });
  response.end(payload);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[stub-api] listening on http://127.0.0.1:${PORT} (scenario: ${scenario})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
