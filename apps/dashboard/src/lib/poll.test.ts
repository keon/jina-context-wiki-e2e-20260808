import assert from "node:assert/strict";
import test from "node:test";
import { fetchCursorPages } from "./poll.ts";

test("cursor pagination combines every page and rejects repeated cursors", async () => {
  const requested: string[] = [];
  const fetchPage = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    return Response.json(
      url.includes("cursor=next-page")
        ? { generations: [{ id: "older" }] }
        : { generations: [{ id: "newer" }], nextCursor: "next-page" }
    );
  };

  const result = await fetchCursorPages<{ generations: { id: string }[] }>(
    "/api/context/generations?limit=100",
    "generations",
    fetchPage
  );
  assert.deepEqual(result.generations, [{ id: "newer" }, { id: "older" }]);
  assert.ok(requested[1]?.includes("limit=100&cursor=next-page"));

  await assert.rejects(
    fetchCursorPages("/api/context/generations", "generations", async () =>
      Response.json({ generations: [], nextCursor: "same" })
    ),
    /repeated a pagination cursor/
  );
});
