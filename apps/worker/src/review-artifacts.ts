import { createHash } from "node:crypto";

import { Storage, type FileMetadata } from "@google-cloud/storage";

const INLINE_RESULT_MAX_BYTES = 12_000;
const REVIEW_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const REVIEW_ARTIFACT_CONTENT_TYPE = "application/json";

export interface ReviewArtifactRef {
  readonly version: 1;
  readonly storage: "gcs";
  readonly uri: string;
  readonly key: string;
  readonly contentType: typeof REVIEW_ARTIFACT_CONTENT_TYPE;
  readonly bytes: number;
  readonly sha256: string;
  readonly objectGeneration: string;
}

export type ReviewTaskResultEnvelope =
  | {
      readonly version: 1;
      readonly kind: string;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly version: 1;
      readonly kind: string;
      readonly artifact: ReviewArtifactRef;
    };

export class GcsReviewArtifactStore {
  readonly #storage: Storage;
  readonly #bucketName: string;

  constructor(
    bucketName: string,
    options: {
      readonly projectId?: string;
      readonly keyFilename?: string;
      readonly storage?: Storage;
    } = {}
  ) {
    if (!bucketName.trim() || bucketName !== bucketName.trim() || /[/?#\\\s\0]/.test(bucketName)) {
      throw new Error("review artifact bucket is invalid");
    }
    this.#bucketName = bucketName;
    this.#storage =
      options.storage ??
      new Storage({
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.keyFilename ? { keyFilename: options.keyFilename } : {})
      });
  }

  async put(input: {
    readonly tenantId: string;
    readonly workflowId: string;
    readonly taskId: string;
    readonly kind: string;
    readonly value: Record<string, unknown>;
  }): Promise<ReviewArtifactRef> {
    const content = canonicalJsonBytes(input.value);
    if (content.byteLength > REVIEW_ARTIFACT_MAX_BYTES) {
      throw new Error(`review artifact exceeds ${REVIEW_ARTIFACT_MAX_BYTES} bytes`);
    }
    const sha256 = digest(content);
    const key = reviewArtifactKey({ ...input, sha256 });
    const bucket = this.#storage.bucket(this.#bucketName);
    const file = bucket.file(key);
    let collided = false;
    try {
      await file.save(content, {
        resumable: content.byteLength >= 5 * 1024 * 1024,
        validation: "crc32c",
        metadata: {
          contentType: REVIEW_ARTIFACT_CONTENT_TYPE,
          metadata: {
            sha256,
            tenantId: input.tenantId,
            workflowId: input.workflowId,
            taskId: input.taskId,
            kind: input.kind
          }
        },
        preconditionOpts: { ifGenerationMatch: 0 }
      });
    } catch (error) {
      if (errorCode(error) !== 412) throw error;
      collided = true;
    }
    const [metadata] = await file.getMetadata();
    assertMetadata(metadata, {
      bytes: content.byteLength,
      sha256,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      taskId: input.taskId,
      kind: input.kind
    });
    const generation = requiredGeneration(metadata);
    if (collided) {
      const [existing] = await bucket.file(key, { generation }).download();
      if (existing.byteLength !== content.byteLength || digest(existing) !== sha256) {
        throw new Error(`review artifact key collision for ${key}`);
      }
    }
    return {
      version: 1,
      storage: "gcs",
      uri: this.uri(key),
      key,
      contentType: REVIEW_ARTIFACT_CONTENT_TYPE,
      bytes: content.byteLength,
      sha256,
      objectGeneration: generation
    };
  }

  async get(ref: ReviewArtifactRef): Promise<Record<string, unknown>> {
    const parsed = parseReviewArtifactRef(ref);
    if (parsed.uri !== this.uri(parsed.key)) throw new Error("review artifact URI does not match its key");
    const file = this.#storage.bucket(this.#bucketName).file(parsed.key, {
      generation: parsed.objectGeneration
    });
    const [metadata] = await file.getMetadata();
    if (
      requiredGeneration(metadata) !== parsed.objectGeneration ||
      Number(metadata.size) !== parsed.bytes ||
      metadata.contentType !== parsed.contentType ||
      metadata.metadata?.sha256 !== parsed.sha256
    ) {
      throw new Error("review artifact metadata does not match its immutable reference");
    }
    const [content] = await file.download();
    if (content.byteLength !== parsed.bytes || digest(content) !== parsed.sha256) {
      throw new Error("review artifact bytes do not match their immutable reference");
    }
    const value: unknown = JSON.parse(content.toString("utf8"));
    if (!isRecord(value)) throw new Error("review artifact JSON must be an object");
    return value;
  }

  private uri(key: string): string {
    return `gs://${this.#bucketName}/${key}`;
  }
}

export async function encodeReviewTaskResult(input: {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly value: Record<string, unknown>;
  readonly store?: GcsReviewArtifactStore;
}): Promise<ReviewTaskResultEnvelope> {
  const content = canonicalJsonBytes(input.value);
  if (content.byteLength <= INLINE_RESULT_MAX_BYTES) {
    return { version: 1, kind: input.kind, value: input.value };
  }
  if (!input.store) {
    throw new Error("JINA_REVIEW_GCS_BUCKET is required for review results larger than 12KB");
  }
  return {
    version: 1,
    kind: input.kind,
    artifact: await input.store.put(input)
  };
}

export async function decodeReviewTaskResult(
  value: unknown,
  expectedKind: string,
  store?: GcsReviewArtifactStore
): Promise<Record<string, unknown>> {
  if (!isRecord(value) || value.version !== 1 || value.kind !== expectedKind) {
    throw new Error(`review task result must be a ${expectedKind} v1 envelope`);
  }
  if (isRecord(value.value)) return value.value;
  if (!store) throw new Error("JINA_REVIEW_GCS_BUCKET is required to read review result artifacts");
  return store.get(parseReviewArtifactRef(value.artifact));
}

export function parseReviewArtifactRef(value: unknown): ReviewArtifactRef {
  if (!isRecord(value)) throw new Error("review artifact reference must be an object");
  const key = requiredString(value.key, "review artifact key");
  const uri = requiredString(value.uri, "review artifact uri");
  const sha256 = requiredString(value.sha256, "review artifact sha256");
  const objectGeneration = requiredString(value.objectGeneration, "review artifact objectGeneration");
  const bytes = Number(value.bytes);
  if (value.version !== 1 || value.storage !== "gcs") throw new Error("unsupported review artifact version");
  if (value.contentType !== REVIEW_ARTIFACT_CONTENT_TYPE) throw new Error("review artifact content type is invalid");
  if (!isCanonicalReviewArtifactKey(key)) throw new Error("review artifact key is not canonical");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("review artifact sha256 is invalid");
  if (!/^[1-9][0-9]*$/.test(objectGeneration)) throw new Error("review artifact generation is invalid");
  if (!Number.isSafeInteger(bytes) || bytes < 2 || bytes > REVIEW_ARTIFACT_MAX_BYTES) {
    throw new Error("review artifact byte length is invalid");
  }
  return {
    version: 1,
    storage: "gcs",
    uri,
    key,
    contentType: REVIEW_ARTIFACT_CONTENT_TYPE,
    bytes,
    sha256,
    objectGeneration
  };
}

function reviewArtifactKey(input: {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly sha256: string;
}): string {
  for (const [label, value] of Object.entries({
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    taskId: input.taskId,
    kind: input.kind
  })) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`);
  }
  return `review-board/v1/${input.tenantId}/${input.workflowId}/${input.taskId}/${input.kind}/${input.sha256}.json`;
}

function isCanonicalReviewArtifactKey(value: string): boolean {
  return /^review-board\/v1\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[0-9a-f]{64}\.json$/.test(
    value
  );
}

function canonicalJsonBytes(value: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredGeneration(metadata: FileMetadata): string {
  const generation = String(metadata.generation ?? "");
  if (!/^[1-9][0-9]*$/.test(generation)) throw new Error("review artifact generation is invalid");
  return generation;
}

function assertMetadata(
  metadata: FileMetadata,
  expected: {
    readonly bytes: number;
    readonly sha256: string;
    readonly tenantId: string;
    readonly workflowId: string;
    readonly taskId: string;
    readonly kind: string;
  }
): void {
  requiredGeneration(metadata);
  if (
    Number(metadata.size) !== expected.bytes ||
    metadata.contentType !== REVIEW_ARTIFACT_CONTENT_TYPE ||
    metadata.metadata?.sha256 !== expected.sha256 ||
    metadata.metadata?.tenantId !== expected.tenantId ||
    metadata.metadata?.workflowId !== expected.workflowId ||
    metadata.metadata?.taskId !== expected.taskId ||
    metadata.metadata?.kind !== expected.kind
  ) {
    throw new Error("review artifact metadata mismatch");
  }
}

function errorCode(error: unknown): number {
  return typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
