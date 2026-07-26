export const contextQueueTopics = {
  ingestEvidence: "run-ingest-evidence",
  deriveKnowledge: "run-derive-knowledge",
  indexContext: "run-index-context"
} as const;

export type ContextQueueTopic = (typeof contextQueueTopics)[keyof typeof contextQueueTopics];

export function isContextQueueTopic(value: string): value is ContextQueueTopic {
  return Object.values(contextQueueTopics).some((topic) => topic === value);
}
