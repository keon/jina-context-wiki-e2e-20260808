export const wikiSourceScopeKinds = ["branch", "pull_request", "commit"] as const;

export type WikiSourceScopeKind = (typeof wikiSourceScopeKinds)[number];

export interface WikiRefIdentity {
  readonly scopeKind: WikiSourceScopeKind;
  readonly scopeKey: string;
  readonly ref: string;
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Returns the only publication ref accepted for a wiki source scope. */
export function canonicalWikiRef(scopeKind: WikiSourceScopeKind, scopeKey: string): string {
  return normalizeWikiRefIdentity({ scopeKind, scopeKey }).ref;
}

/**
 * Normalizes a selector identity without consulting GitHub. The commit itself is
 * resolved before this boundary; this function only canonicalizes its durable
 * publication scope.
 */
export function normalizeWikiRefIdentity(input: {
  readonly scopeKind: WikiSourceScopeKind;
  readonly scopeKey: string;
}): WikiRefIdentity {
  switch (input.scopeKind) {
    case "branch": {
      const scopeKey = normalizeBranchName(input.scopeKey);
      return { scopeKind: input.scopeKind, scopeKey, ref: `refs/heads/${scopeKey}` };
    }
    case "pull_request": {
      const scopeKey = normalizePullRequestNumber(input.scopeKey);
      return { scopeKind: input.scopeKind, scopeKey, ref: `refs/pull/${scopeKey}/head` };
    }
    case "commit": {
      const scopeKey = input.scopeKey.trim().toLowerCase();
      if (!FULL_COMMIT_SHA.test(scopeKey)) throw new Error("commit scopeKey must be a full Git SHA");
      return { scopeKind: input.scopeKind, scopeKey, ref: `refs/commits/${scopeKey}` };
    }
    default:
      throw new Error("wiki source scopeKind is invalid");
  }
}

export function isCanonicalWikiRef(input: WikiRefIdentity): boolean {
  try {
    const normalized = normalizeWikiRefIdentity(input);
    return normalized.scopeKey === input.scopeKey && normalized.ref === input.ref;
  } catch {
    return false;
  }
}

function normalizePullRequestNumber(value: string): string {
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error("pull request scopeKey must be a positive integer");
  const number = Number(normalized);
  if (!Number.isSafeInteger(number)) throw new Error("pull request scopeKey exceeds the supported range");
  return String(number);
}

function normalizeBranchName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    utf8ByteLength(normalized) > 255 ||
    normalized === "@" ||
    normalized.startsWith("-") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".") ||
    normalized.includes("..") ||
    normalized.includes("//") ||
    normalized.includes("@{") ||
    hasInvalidBranchCharacter(normalized) ||
    normalized.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("branch scopeKey is not a valid Git branch name");
  }
  return normalized;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasInvalidBranchCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x20 || codePoint === 0x7f || "~^:?*[\\]".includes(character);
  });
}
