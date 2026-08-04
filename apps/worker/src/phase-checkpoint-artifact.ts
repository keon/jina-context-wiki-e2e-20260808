import { createHash } from "node:crypto";

export function contextPhaseCandidateArtifact(
  phase: string,
  candidate: unknown
): { readonly name: string; readonly content: Buffer } {
  const content = Buffer.from(JSON.stringify(candidate), "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  return { name: `${phase}.${digest}.json`, content };
}
