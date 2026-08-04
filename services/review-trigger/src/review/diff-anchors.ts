export type DiffAnchor = {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
};

export function parseDiffAnchors(diffPatch: string): Set<string> {
  const anchors = new Set<string>();
  let filePath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diffPatch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      filePath = undefined;
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const parsed = parseDiffPath(line.slice(4));
      if (parsed && parsed !== "/dev/null") {
        filePath = parsed;
      }
      continue;
    }

    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }

    if (!filePath || !inHunk || !line) {
      continue;
    }

    const prefix = line[0];
    if (prefix === " ") {
      addAnchor(anchors, { path: filePath, line: newLine, side: "RIGHT" });
      addAnchor(anchors, { path: filePath, line: oldLine, side: "LEFT" });
      oldLine += 1;
      newLine += 1;
    } else if (prefix === "+") {
      addAnchor(anchors, { path: filePath, line: newLine, side: "RIGHT" });
      newLine += 1;
    } else if (prefix === "-") {
      addAnchor(anchors, { path: filePath, line: oldLine, side: "LEFT" });
      oldLine += 1;
    }
  }

  return anchors;
}

function parseDiffPath(value: string): string | undefined {
  const cleaned = value.trim();
  if (cleaned === "/dev/null") {
    return cleaned;
  }
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) {
    return cleaned.slice(2);
  }
  return cleaned || undefined;
}

function addAnchor(anchors: Set<string>, anchor: DiffAnchor): void {
  if (anchor.line > 0) {
    anchors.add(anchorKey(anchor));
  }
}

function anchorKey(anchor: DiffAnchor): string {
  return `${anchor.path}:${anchor.side}:${anchor.line}`;
}
