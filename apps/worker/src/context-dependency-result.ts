import type { ContextArtifactRef } from "@jina/context-engine";

export interface ParsedContextDependencyResult {
  readonly version: 1;
  readonly outputArtifact: ContextArtifactRef;
  readonly disposition?: unknown;
}

export function parsedContextDependencyResult(
  result: Record<string, unknown>,
  outputArtifact: ContextArtifactRef
): ParsedContextDependencyResult {
  return {
    version: 1,
    outputArtifact,
    ...(result.disposition === undefined ? {} : { disposition: result.disposition })
  };
}
