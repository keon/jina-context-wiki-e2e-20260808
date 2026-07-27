import assert from "node:assert/strict";
import test from "node:test";
import { parseGitTreeEntries } from "./git-tree.js";

test("git tree parsing preserves files, executable modes, symlinks, and gitlinks", () => {
  const source = "a".repeat(40);
  const executable = "b".repeat(40);
  const symlink = "c".repeat(40);
  const gitlink = "d".repeat(40);
  assert.deepEqual(
    parseGitTreeEntries(
      [
        `100644 blob ${source} 12\tsrc/index.ts`,
        `100755 blob ${executable} 20\tbin/run`,
        `120000 blob ${symlink} 9\tsrc/current.ts`,
        `160000 commit ${gitlink} -\tvendor/component`,
        ""
      ].join("\0")
    ),
    [
      {
        mode: "100644",
        objectType: "blob",
        objectId: source,
        size: 12,
        path: "src/index.ts",
        entryType: "file"
      },
      {
        mode: "100755",
        objectType: "blob",
        objectId: executable,
        size: 20,
        path: "bin/run",
        entryType: "file"
      },
      {
        mode: "120000",
        objectType: "blob",
        objectId: symlink,
        size: 9,
        path: "src/current.ts",
        entryType: "symlink"
      },
      {
        mode: "160000",
        objectType: "commit",
        objectId: gitlink,
        size: 0,
        path: "vendor/component",
        entryType: "gitlink"
      }
    ]
  );
});
