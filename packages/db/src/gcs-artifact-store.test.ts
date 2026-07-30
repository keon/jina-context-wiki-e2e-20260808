import assert from "node:assert/strict";
import test from "node:test";
import type { FileMetadata, Storage } from "@google-cloud/storage";
import { GcsContextArtifactStore } from "./context/gcs-artifact-store.js";

interface FakeObject {
  content: Buffer;
  metadata: FileMetadata;
}

class FakeStorage {
  readonly objects = new Map<string, FakeObject>();
  #generation = 0;

  bucket(_name: string) {
    return {
      file: (key: string, options?: { readonly generation?: string }) => ({
        save: async (
          content: Buffer,
          saveOptions: {
            readonly metadata: {
              readonly contentType: string;
              readonly customTime?: string;
              readonly metadata: Readonly<Record<string, string>>;
            };
          }
        ) => {
          if (this.objects.has(key)) {
            throw Object.assign(new Error("precondition"), { code: 412 });
          }
          this.#generation += 1;
          this.objects.set(key, {
            content: Buffer.from(content),
            metadata: {
              generation: String(this.#generation),
              size: String(content.byteLength),
              contentType: saveOptions.metadata.contentType,
              ...(saveOptions.metadata.customTime ? { customTime: saveOptions.metadata.customTime } : {}),
              metadata: { ...saveOptions.metadata.metadata }
            }
          });
        },
        getMetadata: async () => {
          const object = this.object(key, options?.generation);
          return [{ ...object.metadata, metadata: { ...object.metadata.metadata } }];
        },
        download: async () => [Buffer.from(this.object(key, options?.generation).content)]
      })
    };
  }

  object(key: string, generation?: string): FakeObject {
    const object = this.objects.get(key);
    if (!object || (generation && object.metadata.generation !== generation)) {
      throw new Error("object not found");
    }
    return object;
  }
}

const write = {
  tenantId: "tenant-a",
  repository: "acme/widgets",
  buildId: "task_build",
  kind: "context-page" as const,
  name: "page.json",
  contentType: "application/json",
  content: Buffer.from('{"page":1}')
};

test("GCS artifacts bind canonical key, URI, generation, metadata, and exact bytes", async () => {
  const fake = new FakeStorage();
  const store = new GcsContextArtifactStore("context-artifacts", {
    storage: fake as unknown as Storage
  });
  const ref = await store.put(write);
  assert.equal(Buffer.from(await store.get(ref)).toString("utf8"), '{"page":1}');
  assert.deepEqual(await store.put(write), ref);
  assert.match(String(fake.object(ref.key).metadata.customTime), /^\d{4}-\d{2}-\d{2}T/);

  await assert.rejects(store.get({ ...ref, uri: `${ref.uri}-other` }), /URI does not match/);
  const { objectGeneration: _generation, ...withoutGeneration } = ref;
  void _generation;
  await assert.rejects(store.get(withoutGeneration), /generation is required/);
  await assert.rejects(store.get({ ...ref, contentType: "text/plain" }), /metadata does not match/);
  await assert.rejects(store.get({ ...ref, bytes: ref.bytes + 1 }), /metadata does not match/);
  await assert.rejects(
    store.get({
      ...ref,
      key: `${ref.key}/../other/page.json`,
      uri: `gs://context-artifacts/${ref.key}/../other/page.json`
    }),
    /key is not canonical/
  );
});

test("GCS keeps certified release seeds outside custom-time lifecycle expiry", async () => {
  const fake = new FakeStorage();
  const store = new GcsContextArtifactStore("context-artifacts", {
    storage: fake as unknown as Storage
  });
  const ref = await store.put({
    ...write,
    kind: "context-release",
    name: "release.json"
  });
  assert.equal(fake.object(ref.key).metadata.customTime, undefined);
});

test("GCS idempotent replay verifies existing bytes instead of trusting custom metadata", async () => {
  const fake = new FakeStorage();
  const store = new GcsContextArtifactStore("context-artifacts", {
    storage: fake as unknown as Storage
  });
  const ref = await store.put(write);
  const object = fake.object(ref.key);
  object.content = Buffer.from('{"page":2}');
  assert.equal(object.content.byteLength, ref.bytes);
  await assert.rejects(store.put(write), /key collision/);
});

test("GCS rejects invalid bucket names without constructing a client", () => {
  for (const bucket of ["", " context-artifacts", "gs://context-artifacts", "context artifacts"]) {
    assert.throws(
      () =>
        new GcsContextArtifactStore(bucket, {
          storage: new FakeStorage() as unknown as Storage
        }),
      /bucket is invalid/
    );
  }
});
