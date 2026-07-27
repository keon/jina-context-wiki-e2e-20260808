import assert from "node:assert/strict";
import test from "node:test";
import { adminApiHeaders, JinaApiError, listAllGenerations, listKnowledgeDocuments } from "./jina-api.ts";

test("admin API requests bind the configured principal and tenant", () => {
  assert.deepEqual(
    adminApiHeaders({
      token: "internal-token",
      tenantId: "tenant-a",
      principalId: "user:admin@example.com"
    }),
    {
      accept: "application/json",
      authorization: "Bearer internal-token",
      "x-jina-principal-id": "user:admin@example.com",
      "x-jina-tenant-id": "tenant-a"
    }
  );
});

test("admin API requests default to the tenant service principal", () => {
  assert.equal(
    adminApiHeaders({ token: "internal-token", tenantId: "tenant-a" })["x-jina-principal-id"],
    "tenant:tenant-a"
  );
});

test("admin API credentials cannot be used without a bound principal", () => {
  assert.throws(() => adminApiHeaders({ token: "internal-token" }), JinaApiError);
  assert.deepEqual(adminApiHeaders({}), { accept: "application/json" });
});

test("admin context listings follow every cursor page", async (context) => {
  const requested: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/context/generations")) {
      return Response.json(
        url.includes("cursor=generation-next")
          ? {
              generations: [
                {
                  id: "generation-older",
                  repository: "acme/repository",
                  ref: "main",
                  commitSha: "b".repeat(40),
                  status: "published",
                  derivedKnowledge: "available",
                  projectors: {},
                  createdAt: "2026-01-01T00:00:00.000Z"
                }
              ]
            }
          : {
              generations: [
                {
                  id: "generation-newer",
                  repository: "acme/repository",
                  ref: "main",
                  commitSha: "a".repeat(40),
                  status: "published",
                  derivedKnowledge: "available",
                  projectors: {},
                  createdAt: "2026-01-02T00:00:00.000Z"
                }
              ],
              nextCursor: "generation-next"
            }
      );
    }
    return Response.json(
      url.includes("cursor=document-next")
        ? {
            documents: [
              {
                id: "document-older",
                logicalId: "component:acme/repository:older",
                repository: "acme/repository",
                kind: "component",
                title: "Older",
                summary: "Older page",
                confidence: 1,
                reviewStatus: "accepted",
                commitSha: "b".repeat(40),
                createdAt: "2026-01-01T00:00:00.000Z"
              }
            ]
          }
        : {
            documents: [
              {
                id: "document-newer",
                logicalId: "component:acme/repository:newer",
                repository: "acme/repository",
                kind: "component",
                title: "Newer",
                summary: "First page",
                confidence: 1,
                reviewStatus: "accepted",
                commitSha: "a".repeat(40),
                createdAt: "2026-01-02T00:00:00.000Z"
              }
            ],
            nextCursor: "document-next"
          }
    );
  });

  assert.deepEqual(
    (await listAllGenerations()).map((generation) => generation.id),
    ["generation-newer", "generation-older"]
  );
  assert.deepEqual(
    (await listKnowledgeDocuments("acme/repository")).map((document) => document.id),
    ["document-newer", "document-older"]
  );
  assert.ok(requested.some((url) => url.includes("cursor=generation-next")));
  assert.ok(
    requested.some((url) => url.includes("repository=acme%2Frepository") && url.includes("cursor=document-next"))
  );
});
