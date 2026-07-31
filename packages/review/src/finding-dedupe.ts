interface FindingFingerprintInput {
  readonly repoId: string;
  readonly path: string;
  readonly rule: string;
  readonly normalizedMessage: string;
}

export function buildFindingFingerprint(input: FindingFingerprintInput): string {
  return [input.repoId, input.path, input.rule, input.normalizedMessage].join(":");
}
