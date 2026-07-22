import { linkedIssueNumbers } from "@jina/context-graph";

/** Selects merged PRs that must be rehydrated even when their commits are already known. */
export function shouldReconcileRecentPullRequest(item: Record<string, unknown>, alreadyHydrated: boolean): boolean {
  if (
    alreadyHydrated ||
    typeof item.number !== "number" ||
    typeof item.merged_at !== "string" ||
    !item.merged_at ||
    typeof item.merge_commit_sha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(item.merge_commit_sha)
  )
    return false;

  const text = `${typeof item.title === "string" ? item.title : ""}\n${typeof item.body === "string" ? item.body : ""}`;
  const links = linkedIssueNumbers(text);
  if (links.resolves.length > 0 || links.references.length > 0) return true;
  return (
    /\b(?:fix(?:e[sd])?|repair(?:s|ed|ing)?|restor(?:e[sd]?|ing)|correct(?:s|ed|ing)?)\b/i.test(text) &&
    /\b(?:bug|regression|incorrect|broken|fail(?:s|ed|ing|ure)?|cannot|can't|unable|denied|wrong)\b/i.test(text)
  );
}
