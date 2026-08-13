/**
 * Returns the oldest pending review without mutating the caller's queue.
 * Completed entries are ignored.
 */
export function selectOldestPendingReview(queue) {
  return queue
    .filter((entry) => entry.status === "pending")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(0);
}
