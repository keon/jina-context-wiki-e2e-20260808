import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GIT_HISTORY = 500;

const extensionLanguages = new Map(
  Object.entries({
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".go": "go",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript",
    ".json": "json",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".md": "markdown",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".php": "php",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".scala": "scala",
    ".sh": "shell",
    ".sql": "sql",
    ".swift": "swift",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml"
  })
);

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

async function git(repositoryDirectory, args, options = {}) {
  const { stdout } = await execFileAsync("git", ["-C", repositoryDirectory, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024
  });
  return stdout;
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : value.toString("utf8").trim();
}

export function languageForRepositoryPath(path) {
  const lower = path.toLowerCase();
  const extension = [...extensionLanguages.keys()]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => lower.endsWith(candidate));
  if (extension) return extensionLanguages.get(extension);
  const basename = lower.split("/").at(-1);
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  return undefined;
}

export async function resolveRepositoryHead(repositoryDirectory) {
  const inside = trimmed(await git(repositoryDirectory, ["rev-parse", "--is-inside-work-tree"]));
  if (inside !== "true") throw new Error(`${repositoryDirectory} is not a Git worktree`);
  const commitSha = trimmed(await git(repositoryDirectory, ["rev-parse", "--verify", "HEAD^{commit}"]));
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error("Context currently requires a 40-character Git commit SHA");
  }
  return commitSha;
}

function parseTree(text) {
  if (!text) return [];
  return text
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40}) +(-|[0-9]+)\t([\s\S]+)$/i.exec(record);
      if (!match) throw new Error(`Unsupported git ls-tree record: ${record.slice(0, 200)}`);
      return {
        mode: match[1],
        objectType: match[2],
        objectId: match[3],
        size: match[4] === "-" ? undefined : Number(match[4]),
        path: match[5]
      };
    });
}

async function treeAt(repositoryDirectory, commitSha) {
  return parseTree(await git(repositoryDirectory, ["ls-tree", "-r", "-z", "-l", "--full-tree", commitSha]));
}

async function commitMetadata(repositoryDirectory, sha) {
  const format = "%T%x00%P%x00%an%x00%aI%x00%cI%x00%B";
  const raw = await git(repositoryDirectory, ["show", "-s", `--format=${format}`, sha]);
  const fields = raw.split("\0");
  if (fields.length < 6) throw new Error(`Could not read Git metadata for ${sha}`);
  const [treeSha, parents, author, authoredAt, committedAt, ...messageParts] = fields;
  return {
    treeSha: treeSha.trim(),
    parentShas: parents.trim() ? parents.trim().split(/\s+/) : [],
    author: author.trim(),
    authoredAt: authoredAt.trim(),
    committedAt: committedAt.trim(),
    message: messageParts.join("\0").trim()
  };
}

function isText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency(values, concurrency, worker) {
  const output = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await worker(values[index], index);
      }
    })
  );
  return output;
}

async function ingestFiles(repositoryDirectory, entries, maxFileBytes) {
  return mapWithConcurrency(entries, 12, async (entry) => {
    if (entry.mode === "160000" || entry.objectType === "commit") {
      return {
        path: entry.path,
        blobSha: entry.objectId,
        body: "",
        contentOmitted: true,
        entryType: "gitlink"
      };
    }
    const language = languageForRepositoryPath(entry.path);
    if (entry.mode !== "120000" && entry.size !== undefined && entry.size > maxFileBytes) {
      return {
        path: entry.path,
        blobSha: entry.objectId,
        body: "",
        ...(language ? { language } : {}),
        executable: entry.mode === "100755",
        contentOmitted: true
      };
    }
    const bytes = await git(repositoryDirectory, ["cat-file", "blob", entry.objectId], {
      encoding: "buffer",
      maxBuffer: Math.max(maxFileBytes + 1024, 1024 * 1024)
    });
    if (entry.mode === "120000") {
      return {
        path: entry.path,
        blobSha: entry.objectId,
        body: "",
        contentOmitted: true,
        entryType: "symlink",
        linkTarget: bytes.toString("utf8")
      };
    }
    const contentOmitted = (entry.size ?? bytes.length) > maxFileBytes || !isText(bytes);
    return {
      path: entry.path,
      blobSha: entry.objectId,
      body: contentOmitted ? "" : bytes.toString("utf8"),
      ...(language ? { language } : {}),
      executable: entry.mode === "100755",
      ...(contentOmitted ? { contentOmitted: true } : {})
    };
  });
}

function changesBetween(currentEntries, priorEntries) {
  const current = new Map(currentEntries.map((entry) => [entry.path, entry.objectId]));
  const prior = new Map(priorEntries.map((entry) => [entry.path, entry.objectId]));
  return [...new Set([...current.keys(), ...prior.keys()])].sort().flatMap((path) => {
    const oldBlobSha = prior.get(path);
    const newBlobSha = current.get(path);
    if (oldBlobSha === newBlobSha) return [];
    if (oldBlobSha === undefined) return [{ kind: "add", path, newBlobSha }];
    if (newBlobSha === undefined) return [{ kind: "delete", path, oldBlobSha }];
    return [{ kind: "modify", path, oldBlobSha, newBlobSha }];
  });
}

/**
 * Collects an immutable repository snapshot from Git objects, never from the
 * mutable working tree. Binary, oversized, symlink, and gitlink entries remain
 * in the manifest but are deliberately unavailable as prose evidence.
 */
export async function collectRepositoryInput({
  repositoryDirectory,
  commitSha,
  historyLimit = 50,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES
}) {
  positiveInteger(historyLimit, "historyLimit", MAX_GIT_HISTORY);
  positiveInteger(maxFileBytes, "maxFileBytes", Number.MAX_SAFE_INTEGER);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("commitSha must be a full 40-character Git SHA");

  const commit = await commitMetadata(repositoryDirectory, commitSha);
  const currentEntries = await treeAt(repositoryDirectory, commitSha);
  const priorEntries = commit.parentShas[0] ? await treeAt(repositoryDirectory, commit.parentShas[0]) : [];
  const historyShas = trimmed(await git(repositoryDirectory, ["rev-list", `--max-count=${historyLimit}`, commitSha]))
    .split(/\r?\n/)
    .filter(Boolean);
  const [files, history] = await Promise.all([
    ingestFiles(repositoryDirectory, currentEntries, maxFileBytes),
    mapWithConcurrency(historyShas, 12, (sha) =>
      commitMetadata(repositoryDirectory, sha).then((item) => ({ sha, ...item }))
    )
  ]);

  return {
    files,
    git: {
      commit,
      changes: changesBetween(currentEntries, priorEntries),
      history
    }
  };
}

export async function createPinnedRepositoryCheckout(repositoryDirectory, commitSha) {
  const root = await mkdtemp(join(tmpdir(), "jina-context-repository-"));
  const checkoutDirectory = join(root, "repository");
  await execFileAsync(
    "git",
    ["clone", "--quiet", "--no-hardlinks", "--no-checkout", repositoryDirectory, checkoutDirectory],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }
  );
  await git(checkoutDirectory, ["checkout", "--quiet", "--detach", commitSha]);
  const checkedOutSha = trimmed(await git(checkoutDirectory, ["rev-parse", "HEAD"]));
  if (checkedOutSha !== commitSha) throw new Error(`Pinned checkout resolved ${checkedOutSha}, expected ${commitSha}`);
  return { root, checkoutDirectory };
}
