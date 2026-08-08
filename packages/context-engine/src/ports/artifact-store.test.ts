import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  FileContextArtifactStore,
  artifactSha256,
  contextArtifactKey,
  isContextArtifactKeyInScope
} from "./artifact-store.js";
import {
  parseWikiContentBundle,
  serializeWikiContentBundle,
  validateWikiContentArtifactRef,
  wikiContentArtifactKey,
  wikiContentBundleSha256
} from "./wiki-content-store.js";
import { contextPublicSnapshotDigest } from "../publication/board-publication.js";

test("local artifacts use tenant-scoped GCS-compatible keys and round-trip exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-context-artifacts-"));
  try {
    const store = new FileContextArtifactStore(root);
    const input = {
      tenantId: "tenant-a",
      repository: "acme/widgets",
      buildId: "build-1",
      kind: "context-release" as const,
      name: "release.json",
      contentType: "application/json",
      content: '{"release":"one"}'
    };
    assert.equal(
      contextArtifactKey(input),
      "context/tenants/tenant-a/repositories/acme/widgets/builds/build-1/context-release/release.json"
    );
    const ref = await store.put(input);
    assert.deepEqual(
      await store.find({
        tenantId: input.tenantId,
        repository: input.repository,
        buildId: input.buildId,
        kind: input.kind,
        name: input.name,
        contentType: input.contentType
      }),
      ref
    );
    assert.equal(
      await store.find({
        tenantId: input.tenantId,
        repository: input.repository,
        buildId: input.buildId,
        kind: input.kind,
        name: "absent.json",
        contentType: input.contentType
      }),
      undefined
    );
    assert.deepEqual(await store.put(input), ref);
    await assert.rejects(store.put({ ...input, content: '{"release":"different"}' }), /artifact key collision/);
    const bytes = await store.get(ref);
    assert.equal(Buffer.from(bytes).toString("utf8"), input.content);
    assert.equal(ref.bytes, Buffer.byteLength(input.content));
    assert.equal(ref.sha256, artifactSha256(bytes));
    assert.equal(ref.key, contextArtifactKey(input));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact keys reject repository traversal and encode slashes in opaque segments", () => {
  assert.throws(() =>
    contextArtifactKey({
      tenantId: "tenant",
      repository: "../outside",
      buildId: "build",
      kind: "derivation-checkpoint",
      name: "page.md",
      contentType: "text/markdown",
      content: "unsafe"
    })
  );
  const key = contextArtifactKey({
    tenantId: "tenant/other",
    repository: "acme/outside",
    buildId: "build/one",
    kind: "derivation-checkpoint",
    name: "../../page.md",
    contentType: "text/markdown",
    content: "safe"
  });
  assert.match(key, /tenant%2Fother/);
  assert.match(key, /build%2Fone/);
  assert.match(key, /\.\.%2F\.\.%2Fpage\.md/);
  assert.equal(key.includes("/../"), false);
});

test("artifact scope checks reject dot-segment prefix escapes", () => {
  const scope = {
    tenantId: "tenant",
    repository: "acme/widgets",
    buildId: "build-one"
  };
  assert.equal(
    isContextArtifactKeyInScope(
      "context/tenants/tenant/repositories/acme/widgets/builds/build-one/context-page/page.json",
      scope
    ),
    true
  );
  assert.equal(
    isContextArtifactKeyInScope(
      "context/tenants/tenant/repositories/acme/widgets/builds/build-one/../build-two/context-page/page.json",
      scope
    ),
    false
  );
  assert.equal(
    isContextArtifactKeyInScope(
      "context/tenants/tenant/repositories/acme/widgets/builds/build-one\\..\\build-two\\page.json",
      scope
    ),
    false
  );
});

test("local artifacts reject symlinked directories, files, and mismatched references", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-context-artifact-links-"));
  const outside = await mkdtemp(join(tmpdir(), "jina-context-artifact-outside-"));
  const input = {
    tenantId: "tenant",
    repository: "acme/widgets",
    buildId: "build-one",
    kind: "context-page" as const,
    name: "page.json",
    contentType: "application/json",
    content: '{"page":1}'
  };
  try {
    await symlink(outside, join(root, "context"));
    await assert.rejects(new FileContextArtifactStore(root).put(input), /symbolic link/);
    await unlink(join(root, "context"));

    const store = new FileContextArtifactStore(root);
    const ref = await store.put(input);
    const alias = join(outside, "root-alias");
    await symlink(root, alias, "dir");
    assert.equal(
      Buffer.from(
        await store.get({
          ...ref,
          uri: pathToFileURL(join(alias, ref.key)).href
        })
      ).toString("utf8"),
      input.content
    );
    await assert.rejects(store.get({ ...ref, bytes: ref.bytes + 1 }), /immutable reference/);
    await assert.rejects(store.get({ ...ref, uri: `${ref.uri}-other` }), /URI does not match/);

    const target = new URL(ref.uri);
    await unlink(target);
    const outsideFile = join(outside, "page.json");
    await writeFile(outsideFile, input.content);
    await symlink(outsideFile, target);
    await assert.rejects(store.get(ref), /regular unlinked file/);

    await unlink(target);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("wiki content bundles are exact-byte deterministic and repository scoped", () => {
  const bodyMarkdown = "# Wiki\n\nUsable from the first release.\n";
  const bodySha256 = createHash("sha256").update(bodyMarkdown).digest("hex");
  const publicSnapshotDigest = contextPublicSnapshotDigest([
    { documentPath: "index.md", title: "index.md", bodyMarkdown }
  ]);
  const bundle = parseWikiContentBundle({
    version: 1,
    publicSnapshotDigest,
    pages: [{ documentPath: "index.md", bodyMarkdown, bodySha256 }]
  });
  const serialized = serializeWikiContentBundle(bundle);
  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(wikiContentBundleSha256(bundle), createHash("sha256").update(serialized).digest("hex"));
  const bundleSha256 = wikiContentBundleSha256(bundle);
  const key = wikiContentArtifactKey({ tenantId: "tenant-a", repository: "Acme/Widgets", bundleSha256 });
  assert.equal(key, `context/tenants/tenant-a/repositories/acme/widgets/wiki-content/${bundleSha256}.json`);
  assert.throws(
    () =>
      validateWikiContentArtifactRef(
        {
          version: 1,
          tenantId: "tenant-a",
          repository: "acme/widgets",
          publicSnapshotDigest,
          bundleSha256,
          uri: `gs://bucket/${key}`,
          key,
          contentType: "application/json",
          bytes: Buffer.byteLength(serialized),
          sha256: bundleSha256,
          objectGeneration: "7"
        },
        { tenantId: "tenant-b", repository: "acme/widgets" }
      ),
    /escapes its authorized repository scope/
  );
});
