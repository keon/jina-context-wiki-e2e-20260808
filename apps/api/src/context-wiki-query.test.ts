import assert from "node:assert/strict";
import test from "node:test";
import type { WikiContentArtifactRef, WikiContentBundleV1 } from "@jina/context-engine";
import {
  ContextWikiQueryService,
  WikiSelectorError,
  canonicalWikiLocale,
  parseWikiSelector,
  parseWikiSelectorObject,
  type WikiAuditSummary,
  type WikiReleaseIdentity,
  type WikiReleaseQueryStore
} from "./context-wiki-query.js";

const artifact: WikiContentArtifactRef = {
  version: 1,
  tenantId: "tenant",
  repository: "acme/widgets",
  publicSnapshotDigest: "b".repeat(64),
  key: "context-v2/tenants/tenant/repositories/acme/widgets/wiki-content/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
  uri: "gs://bucket/context-v2/wiki-content.json",
  contentType: "application/json",
  sha256: "a".repeat(64),
  bundleSha256: "a".repeat(64),
  bytes: 42,
  objectGeneration: "7"
};

function release(overrides: Partial<WikiReleaseIdentity> = {}): WikiReleaseIdentity {
  return {
    releaseId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    releaseFamilyId: "wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repository: "acme/widgets",
    ref: "refs/heads/main",
    refSequence: 1,
    commitSha: "a".repeat(40),
    publicSnapshotDigest: "b".repeat(64),
    locale: "en",
    scopeKind: "branch",
    scopeKey: "main",
    publishedAt: "2026-08-08T00:00:00.000Z",
    contentBundleArtifact: artifact,
    ...overrides
  };
}

test("wiki selector is a strict mutually-exclusive union and canonicalizes legacy refs", () => {
  assert.deepEqual(parseWikiSelector({ branch: "feature/docs" }, { allowOmitted: false }), {
    branch: "feature/docs"
  });
  assert.deepEqual(parseWikiSelector({ ref: "refs/pull/42/head" }, { allowOmitted: false }), {
    pullRequest: 42
  });
  assert.deepEqual(parseWikiSelectorObject({ commitSha: "A".repeat(40) }, { allowOmitted: false }), {
    commitSha: "a".repeat(40)
  });
  assert.throws(
    () => parseWikiSelector({ releaseId: "release", branch: "main" }, { allowOmitted: false }),
    /mutually exclusive/
  );
  assert.throws(() => parseWikiSelectorObject({ branch: "main", surprise: true }, { allowOmitted: false }), /unknown/);
  assert.throws(() => parseWikiSelector({}, { allowOmitted: false }), /exactly one/);
});

test("locale is canonical, bounded, and never an any-locale wildcard", () => {
  assert.equal(canonicalWikiLocale(undefined, "EN"), "en");
  assert.equal(canonicalWikiLocale("pt-BR", "en"), "pt-br");
  assert.equal(canonicalWikiLocale("en-US", "en"), "en-us");
  assert.throws(() => canonicalWikiLocale("*", "en"), /invalid/);
});

test("selector resolution passes a regional locale to storage in its canonical spelling", async () => {
  let selectedLocale: string | undefined;
  const regional = release({ locale: "en-us" });
  const service = new ContextWikiQueryService(
    fakeStore({
      findCurrentPublishedWikiRelease: async (input) => {
        selectedLocale = input.locale;
        return regional;
      }
    }),
    config
  );

  const resolved = await service.resolve({
    tenantId: "tenant",
    repository: "acme/widgets",
    selector: { branch: "main" },
    locale: "en-US"
  });
  assert.equal(selectedLocale, "en-us");
  assert.equal(resolved.release.locale, "en-us");
});

test("resolver follows locale-specific refs, resolves commits, and derives exact-release locale", async () => {
  const calls: string[] = [];
  const english = release();
  const french = release({
    releaseId: "cr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    generationId: "cr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    locale: "fr"
  });
  const store = fakeStore({
    findPublishedWikiRelease: async () => french,
    findCurrentPublishedWikiRelease: async (input) => {
      calls.push(`ref:${input.ref}:${input.locale}`);
      return english;
    },
    findNewestPublishedWikiReleaseForCommit: async (input) => {
      calls.push(`commit:${input.commitSha}:${input.locale}`);
      return english;
    }
  });
  const service = new ContextWikiQueryService(store, config);
  assert.equal(
    (await service.resolve({ tenantId: "tenant", repository: "acme/widgets" })).release.releaseId,
    english.releaseId
  );
  await service.resolve({
    tenantId: "tenant",
    repository: "acme/widgets",
    selector: { commitSha: "a".repeat(40) },
    locale: "en"
  });
  const exact = await service.resolve({
    tenantId: "tenant",
    repository: "acme/widgets",
    selector: { releaseId: french.releaseId }
  });
  assert.equal(exact.release.locale, "fr");
  await assert.rejects(
    service.resolve({
      tenantId: "tenant",
      repository: "acme/widgets",
      selector: { releaseId: french.releaseId },
      locale: "en"
    }),
    (error) => error instanceof WikiSelectorError && error.message.includes("does not match")
  );
  assert.deepEqual(calls, [`ref:refs/heads/main:en`, `commit:${"a".repeat(40)}:en`]);
});

test("list carries the active-policy audit summary and export hydrates the immutable bundle", async () => {
  const published = release();
  const audit: WikiAuditSummary = {
    quality: "needs_improvement",
    auditId: "audit-1",
    auditPolicyVersion: "audit-v2",
    auditedAt: "2026-08-08T01:00:00.000Z"
  };
  const store = fakeStore({
    listPublishedWikiReleases: async () => [published],
    findPublishedWikiRelease: async () => published,
    latestWikiAuditSummary: async () => audit
  });
  const bundle = { format: "wiki-content-bundle-v1" } as unknown as WikiContentBundleV1;
  const service = new ContextWikiQueryService(store, config, { get: async () => bundle });
  assert.deepEqual((await service.list({ tenantId: "tenant", repository: "acme/widgets" }))[0]?.audit, audit);
  assert.equal(
    (
      await service.export({
        tenantId: "tenant",
        repository: "acme/widgets",
        selector: { releaseId: published.releaseId }
      })
    ).bundle,
    bundle
  );
});

const config = { defaultBranch: "main", defaultLocale: "en", auditPolicyVersion: "audit-v2" };

function fakeStore(overrides: Partial<WikiReleaseQueryStore>): WikiReleaseQueryStore {
  return {
    findPublishedWikiRelease: async () => undefined,
    findCurrentPublishedWikiRelease: async () => undefined,
    findNewestPublishedWikiReleaseForCommit: async () => undefined,
    listPublishedWikiReleases: async () => [],
    latestWikiAuditSummary: async () => undefined,
    ...overrides
  };
}
