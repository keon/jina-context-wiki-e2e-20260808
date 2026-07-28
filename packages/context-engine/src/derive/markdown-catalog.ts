import { knowledgeDocumentKinds, type KnowledgeDocumentKind } from "../domain/knowledge.js";
import type { ParsedMarkdownDocument } from "./markdown-document.js";

/**
 * Maps a Markdown folder onto the knowledge documents the store already holds.
 *
 * The path *is* the identity, and the repository chooses its own structure:
 *
 *   architecture.md                       ->  repository:owner/repo:architecture
 *   runbooks/stalled-publication.md       ->  runbook:owner/repo:stalled-publication
 *   extensions/host/activation-events.md  ->  topic:owner/repo:extensions/host/activation-events
 *
 * A wiki's structure should fit the thing it documents. An editor has an
 * extension host and a language server; a library has neither, and a data
 * pipeline has stages instead. So folders are not a fixed taxonomy: a folder this
 * engine recognises tags its documents with that kind, because retrieval can use
 * it, and any other folder is a topic whose identity is its whole path. Nothing
 * is rejected for being organised the way its repository is actually organised.
 *
 * Either way the identifier satisfies the per-kind patterns already in the
 * schema, so validation, indexing, retrieval and the dashboard keep working with
 * no migration — the patterns already allowed a subject to be a path.
 */

/**
 * Folders this engine recognises. Not a required layout — a convenience, so that
 * a repository which does organise itself around runbooks or flows gets those
 * documents tagged for retrieval rather than flattened into topics.
 *
 * Plural on disk because a folder holds many.
 */
const KIND_DIRECTORIES: Readonly<Record<string, KnowledgeDocumentKind>> = {
  components: "component",
  features: "feature",
  decisions: "decision",
  changes: "change_summary",
  incidents: "incident",
  issues: "issue_explanation",
  ownership: "ownership",
  runbooks: "runbook",
  glossary: "glossary",
  flows: "flow",
  patterns: "pattern"
};

/** The folder a kind is written to, so the prompt and the reader agree. */
export const kindDirectories: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KIND_DIRECTORIES).map(([directory, kind]) => [kind, directory])
);

export interface MarkdownCatalogEntry {
  readonly logicalId: string;
  readonly kind: KnowledgeDocumentKind;
  readonly title: string;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly documentPath: string;
}

export interface MarkdownCatalogProblem {
  readonly documentPath: string;
  readonly reason: "empty-subject" | "unsupported-identifier";
}

export interface MarkdownCatalogMapping {
  readonly entries: readonly MarkdownCatalogEntry[];
  readonly problems: readonly MarkdownCatalogProblem[];
}

/**
 * The lead paragraph, which is what a listing shows.
 *
 * Taking it from the document rather than asking the author for a separate field
 * keeps the file plain: a wiki page's first paragraph is already its summary.
 */
export function leadParagraph(bodyMarkdown: string): string {
  for (const block of bodyMarkdown.split(/\n{2,}/)) {
    const text = block
      .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
      .replace(/^#{1,6}\s+.*$/gm, "")
      .replace(/^[-*+]\s+/gm, "")
      .trim();
    if (text) return text.replace(/\s+/g, " ");
  }
  return "";
}

function isKind(value: string): value is KnowledgeDocumentKind {
  return (knowledgeDocumentKinds as readonly string[]).includes(value);
}

/** Lowercases and strips what the logical ID patterns do not admit. */
function subjectSlug(segments: readonly string[]): string {
  return segments
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9_.:/-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean)
    .join("/");
}

export function mapMarkdownCatalog(
  documents: readonly ParsedMarkdownDocument[],
  repository: string
): MarkdownCatalogMapping {
  const entries: MarkdownCatalogEntry[] = [];
  const problems: MarkdownCatalogProblem[] = [];
  const normalizedRepository = repository.toLowerCase();

  for (const document of documents) {
    const segments = document.documentPath.split("/").filter(Boolean);
    const summary = leadParagraph(document.bodyMarkdown);
    const common = {
      title: document.title,
      summary,
      bodyMarkdown: document.bodyMarkdown,
      documentPath: document.documentPath
    };

    // The one document that describes the repository itself sits at the root,
    // because it is not one of many of anything.
    if (segments.length === 1 && segments[0]!.toLowerCase() === "architecture") {
      entries.push({
        ...common,
        kind: "architecture",
        logicalId: `repository:${normalizedRepository}:architecture`
      });
      continue;
    }

    // A recognised folder tags its documents with that kind and drops the folder
    // from the subject, because the kind already carries it. Any other folder is
    // the repository's own structure, so the whole path is the subject and the
    // folders survive as folders.
    const directory = segments[0]?.toLowerCase() ?? "";
    const recognised = KIND_DIRECTORIES[directory];
    const kind: KnowledgeDocumentKind = recognised && isKind(recognised) ? recognised : "topic";
    const subject = subjectSlug(recognised ? segments.slice(1) : segments);
    if (!subject) {
      problems.push({ documentPath: document.documentPath, reason: "empty-subject" });
      continue;
    }
    // An issue explanation identifies a numbered issue rather than a slug, so a
    // path that does not name one cannot become a valid identifier.
    if (kind === "issue_explanation" && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/.test(subject)) {
      problems.push({ documentPath: document.documentPath, reason: "unsupported-identifier" });
      continue;
    }
    const prefix = kind === "change_summary" ? "change" : kind === "issue_explanation" ? "issue" : kind;
    entries.push({ ...common, kind, logicalId: `${prefix}:${normalizedRepository}:${subject}` });
  }

  return { entries, problems };
}
