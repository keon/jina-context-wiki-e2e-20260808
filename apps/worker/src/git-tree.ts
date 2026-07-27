type GitTreeEntryType = "file" | "symlink" | "gitlink";

export interface GitTreeEntry {
  readonly mode: string;
  readonly objectType: "blob" | "commit";
  readonly objectId: string;
  readonly size: number;
  readonly path: string;
  readonly entryType: GitTreeEntryType;
}

export function parseGitTreeEntries(value: string): GitTreeEntry[] {
  return value
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+)\s+(blob|commit)\s+([0-9a-f]{40})\s+(\d+|-)\t(.+)$/.exec(entry);
      if (!match) throw new Error(`unsupported git tree entry: ${entry.slice(0, 120)}`);
      const mode = match[1]!;
      const objectType = match[2]! as "blob" | "commit";
      const entryType =
        mode === "160000" && objectType === "commit"
          ? "gitlink"
          : mode === "120000" && objectType === "blob"
            ? "symlink"
            : (mode === "100644" || mode === "100755") && objectType === "blob"
              ? "file"
              : undefined;
      if (!entryType) throw new Error(`unsupported git tree entry: ${entry.slice(0, 120)}`);
      return {
        mode,
        objectType,
        objectId: match[3]!,
        size: match[4] === "-" ? 0 : Number(match[4]),
        path: match[5]!,
        entryType
      };
    });
}
