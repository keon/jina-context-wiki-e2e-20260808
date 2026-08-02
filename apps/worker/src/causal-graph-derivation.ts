export const ISSUE_GRAPH_STAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "summary", "issues", "causalities", "candidateDispositions"],
  properties: {
    version: { type: "integer", const: 1 },
    summary: { type: "string", minLength: 1, maxLength: 4_000 },
    issues: {
      type: "array",
      maxItems: 2_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "summary", "evidence"],
        properties: {
          key: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" },
          title: { type: "string", minLength: 4, maxLength: 200 },
          summary: { type: "string", minLength: 12, maxLength: 4_000 },
          evidence: { type: "array", minItems: 1, maxItems: 100, items: issueEvidenceSchema() }
        }
      }
    },
    causalities: {
      type: "array",
      maxItems: 5_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subjectKey", "predicate", "objectKind", "objectRef", "why", "confidence", "evidence"],
        properties: {
          subjectKey: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" },
          predicate: { type: "string", enum: ["CAUSED_BY", "RESOLVED_BY", "CONTRIBUTES_TO"] },
          objectKind: { type: "string", enum: ["issue", "commit"] },
          objectRef: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" },
          why: { type: "string", minLength: 12, maxLength: 2_000 },
          confidence: { type: "string", const: "explicit" },
          evidence: { type: "array", minItems: 1, maxItems: 100, items: issueEvidenceSchema() }
        }
      }
    },
    candidateDispositions: {
      type: "array",
      maxItems: 50_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commitSha", "disposition", "issueKeys", "reason"],
        properties: {
          commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
          disposition: {
            type: "string",
            enum: ["issue", "duplicate", "non_issue", "insufficient_evidence"]
          },
          issueKeys: {
            type: "array",
            maxItems: 100,
            items: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,119}$" }
          },
          reason: { type: "string", minLength: 8, maxLength: 1_000 }
        }
      }
    }
  }
} as const;

export function issueGraphPrompt(
  repository: string,
  ref: string,
  historyPath: string,
  candidateLedgerPath: string,
  minimumIssues: number
): string {
  return [
    `Derive an exhaustive, evidence-grounded engineering issue and causality graph for ${repository}@${ref}.`,
    `The sole evidence source is the bounded commit-history file at ${historyPath}.`,
    `A deterministic high-signal commit ledger is at ${candidateLedgerPath}. It is an index into the same history, not a second evidence source.`,
    "Read it directly. This is one agentic derivation run; do not create a plan, delegate, or invoke a critic.",
    "Work in two explicit passes inside this one run. First scan the full history chronologically and derive the issue set. Second, before writing JSON, trace each resolved issue backward through earlier commits for the mechanism or design that made the failure possible.",
    "For every ledger entry, emit exactly one concise candidateDisposition. Use issue when it directly evidences a distinct issue, duplicate when it belongs to an issue already represented, non_issue for ordinary work despite the lexical signal, and insufficient_evidence only when the commit message cannot support a defensible decision. issue and duplicate dispositions require issueKeys; the other dispositions require an empty issueKeys array.",
    "An issue is a concrete defect, failure mode, operational constraint, or harmful design tradeoff visible in commit messages. Do not turn ordinary features, refactors, or chores into issues.",
    `Derive at least ${minimumIssues} distinct issues. This is a host-enforced recall floor, not permission to speculate: cluster repeated fixes into one issue, but preserve genuinely different symptoms, failure modes, races, resource limits, data-integrity problems, and operational constraints.`,
    "Every issue needs exact 1-based commit-message line ranges. Use introduced, observed, and resolved roles only when the cited text supports that role.",
    "Every commitSha and commit objectRef must be copied exactly from the history as a full 40-character lowercase SHA. Before returning, verify every SHA has exactly 40 hexadecimal characters; never abbreviate it.",
    `The result is rejected unless at least ${Math.min(3, minimumIssues)} distinct issues cite genuine introduced evidence. An earlier commit is valid introduced evidence when its own message says it created the mechanism or design that a later repair identifies as faulty; the later repair does not need to name the earlier SHA. Match concrete component and behavior terms across the two messages. Do not relabel a repair as introduced, and do not use a parent merely because the issue existed in that repository state.`,
    `Before returning, self-check that at least ${Math.min(3, minimumIssues)} issue objects contain an evidence anchor whose role is exactly introduced. If not, continue the backward history search instead of returning.`,
    "The host deterministically creates commit CAUSED_BY edges from introduced evidence and RESOLVED_BY edges from resolved evidence. Do not repeat those lifecycle edges. Use the causalities array for explicit issue-to-issue CAUSED_BY or CONTRIBUTES_TO relationships found in the history.",
    "Every subjectKey and issue objectRef must exactly copy one lowercase key from the issues array. Never invent or recase an issue reference.",
    "Emit a causality only when the commit history states the relationship explicitly enough to defend. confidence must be explicit. Omit guesses and ambiguous relationships.",
    "Every issue key must be referenced by at least one candidateDisposition. Use evidence from at least ten distinct commits when the recall floor is ten or greater.",
    "Return only the schema-conforming JSON result."
  ].join("\n\n");
}

function issueEvidenceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["commitSha", "role", "messageStartLine", "messageEndLine"],
    properties: {
      commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      role: { type: "string", enum: ["introduced", "observed", "resolved"] },
      messageStartLine: { type: "integer", minimum: 1 },
      messageEndLine: { type: "integer", minimum: 1 }
    }
  } as const;
}
