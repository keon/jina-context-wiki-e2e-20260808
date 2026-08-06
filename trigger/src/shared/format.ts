// Human-readable formatting helpers for PR comment and check-run text.

// Join a list of names into an Oxford-comma phrase:
//   ["a"]            -> "a"
//   ["a", "b"]       -> "a and b"
//   ["a", "b", "c"]  -> "a, b, and c"
export function formatList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0]!;
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// Pluralize a noun against a count: pluralize(1, "file") -> "1 file",
// pluralize(3, "file") -> "3 files".
export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
