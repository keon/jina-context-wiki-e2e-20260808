export function assertExpectedRemoteHead(
  repository: string,
  ref: string,
  remoteHeadSha: string,
  expectedCommitSha?: string
): string {
  const remote = normalizedGitSha(remoteHeadSha, "remote ref commit");
  if (expectedCommitSha === undefined) return remote;
  const expected = normalizedGitSha(expectedCommitSha, "expected commit");
  if (remote !== expected) {
    throw new Error(
      `repository ref ${repository}@${ref} moved from expected ${expected} to ${remote}; refusing stale context build`
    );
  }
  return remote;
}

function normalizedGitSha(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(normalized)) throw new Error(`${name} must be a full Git SHA`);
  return normalized;
}
