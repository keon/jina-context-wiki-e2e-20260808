export function buildPublicationKey(prId: string, headSha: string, target: string): string {
  return `pr:${prId}:${target}:${headSha}`;
}
