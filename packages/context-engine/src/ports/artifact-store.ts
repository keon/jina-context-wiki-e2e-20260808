import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const contextArtifactKinds = [
  "evidence-snapshot",
  "provider-bundle",
  "research-plan",
  "research-report",
  "publication-plan",
  "context-page",
  "context-draft",
  "citation-audit",
  "gate-evaluation",
  "certification",
  "derivation-checkpoint",
  "derivation-private-checkpoint",
  "context-release",
  "issue-history",
  "issue-graph",
  "pageindex-tree"
] as const;

export type ContextArtifactKind = (typeof contextArtifactKinds)[number];

export interface ContextArtifactWrite {
  readonly tenantId: string;
  readonly repository: string;
  readonly buildId: string;
  readonly kind: ContextArtifactKind;
  readonly name: string;
  readonly contentType: string;
  readonly content: string | Uint8Array;
}

export interface ContextArtifactRef {
  readonly uri: string;
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly objectGeneration?: string;
}

export interface ContextArtifactStore {
  put(input: ContextArtifactWrite): Promise<ContextArtifactRef>;
  get(ref: ContextArtifactRef): Promise<Uint8Array>;
}

export interface ContextArtifactScope {
  readonly tenantId: string;
  readonly repository: string;
  readonly buildId: string;
}

export interface ContextArtifactRepositoryScope {
  readonly tenantId: string;
  readonly repository: string;
}

function safeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("\0")) {
    throw new Error("artifact path segment is invalid");
  }
  return encodeURIComponent(trimmed);
}

export function contextArtifactScopePrefix(input: ContextArtifactScope): string {
  return [contextArtifactRepositoryPrefix(input), "builds", safeSegment(input.buildId)].join("/");
}

export function contextArtifactRepositoryPrefix(input: ContextArtifactRepositoryScope): string {
  return [
    "context",
    "tenants",
    safeSegment(input.tenantId),
    "repositories",
    ...input.repository.split("/").map(safeSegment)
  ].join("/");
}

export function isCanonicalContextArtifactKey(key: string): boolean {
  if (!key || key.length > 4_096 || key.includes("\\") || key.includes("\0")) return false;
  const segments = key.split("/");
  return (
    segments.length >= 9 &&
    segments[0] === "context" &&
    segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
  );
}

export function isContextArtifactKeyInScope(key: string, input: ContextArtifactScope): boolean {
  if (!isCanonicalContextArtifactKey(key)) return false;
  const prefix = contextArtifactScopePrefix(input);
  return key.startsWith(`${prefix}/`);
}

export function isContextArtifactKeyInRepositoryScope(key: string, input: ContextArtifactRepositoryScope): boolean {
  if (!isCanonicalContextArtifactKey(key)) return false;
  const prefix = contextArtifactRepositoryPrefix(input);
  return key.startsWith(`${prefix}/builds/`);
}

export function contextArtifactKey(input: ContextArtifactWrite): string {
  return [contextArtifactScopePrefix(input), safeSegment(input.kind), safeSegment(input.name)].join("/");
}

export function artifactBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

export function artifactSha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Local development adapter with atomic rename and the same object keys as GCS. */
export class FileContextArtifactStore implements ContextArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error("artifact root is required");
    this.#root = resolve(root);
  }

  async put(input: ContextArtifactWrite): Promise<ContextArtifactRef> {
    const key = contextArtifactKey(input);
    const target = await this.writableTarget(key);
    const content = artifactBytes(input.content);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content);
    try {
      await link(temporary, target);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      await this.assertRegularArtifact(target);
      const existing = await readFile(target);
      if (artifactSha256(existing) !== artifactSha256(content)) {
        throw new Error(`local artifact key collision for ${key}`, { cause: error });
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return {
      uri: pathToFileURL(target).href,
      key,
      contentType: input.contentType,
      bytes: content.byteLength,
      sha256: artifactSha256(content)
    };
  }

  async get(ref: ContextArtifactRef): Promise<Uint8Array> {
    const target = await this.readableTarget(ref.key);
    let uriTarget: string;
    try {
      uriTarget = await realpath(fileURLToPath(ref.uri));
    } catch {
      throw new Error("local artifact URI does not match its key");
    }
    if (uriTarget !== target) throw new Error("local artifact URI does not match its key");
    const content = await readFile(target);
    if (content.byteLength !== ref.bytes || artifactSha256(content) !== ref.sha256) {
      throw new Error("local artifact bytes do not match their immutable reference");
    }
    return content;
  }

  private target(root: string, key: string): string {
    if (!isCanonicalContextArtifactKey(key)) throw new Error("artifact key is not canonical");
    const target = resolve(root, key);
    if (!target.startsWith(`${root}${sep}`)) throw new Error("artifact key escapes its root");
    return target;
  }

  private async writableTarget(key: string): Promise<string> {
    const root = await this.safeRoot();
    const target = this.target(root, key);
    let current = root;
    for (const segment of key.split("/").slice(0, -1)) {
      current = join(current, segment);
      await mkdir(current).catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (code !== "EEXIST") throw error;
      });
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("local artifact directory contains a symbolic link or non-directory");
      }
    }
    return target;
  }

  private async readableTarget(key: string): Promise<string> {
    const root = await this.safeRoot();
    const target = this.target(root, key);
    let current = root;
    for (const segment of key.split("/").slice(0, -1)) {
      current = join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("local artifact directory contains a symbolic link or non-directory");
      }
    }
    await this.assertRegularArtifact(target);
    return target;
  }

  private async safeRoot(): Promise<string> {
    await mkdir(this.#root, { recursive: true });
    const stat = await lstat(this.#root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("artifact root must be a real directory");
    }
    return realpath(this.#root);
  }

  private async assertRegularArtifact(target: string): Promise<void> {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error("local artifact must be a regular unlinked file");
    }
  }
}
