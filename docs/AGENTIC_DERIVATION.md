# Agentic knowledge derivation

`derive-knowledge` is the required interpretation stage between canonical evidence and
the enriched context index. It uses Codex to inspect an exact repository checkpoint and
organize evidence into durable, cited knowledge documents. It does not create graph nodes
or model-proposed edges.

The conceptual data flow is:

```text
ingest-evidence
  -> required derive-knowledge
  -> index-context
```

The coordinator first publishes a raw-evidence `index-context` baseline after ingestion.
It then runs required derivation and publishes the enriched `index-context` successor.
The baseline makes exact evidence available for diagnosis and retry, but a failed
derivation still fails the root build.

## Agent workspace

The context worker fetches and validates the authoritative ref, checks out the exact full
commit SHA, and creates a Git archive from that commit. The Daytona executor extracts the
archive at `/home/daytona/repository` and starts Codex there with:

- a read-only shell and read-only repository tree;
- no repository credential;
- no network or web search;
- no user configuration or repository instructions;
- no login shell, environment inheritance, plugins, apps, browser, computer use,
  image generation, hooks, workspace dependencies, or subagents;
- `approval_policy="never"` and a schema-constrained final result.

Codex may use ordinary read-only shell exploration such as path listing and text search.
It may not execute repository code, install dependencies, mutate files, inspect process
state or credentials, or access paths outside the repository and derivation-input
directories. Repository files and provider text are untrusted data, never instructions.

The agent receives three host-created inputs in `/home/daytona/derive-input`:

| Input                      | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `evidence.json`            | Bounded immutable evidence catalog with source IDs, digests, metadata, and citable bodies  |
| `repository-manifest.json` | Exact checkpoint tree mapping paths to blob SHAs and content availability                  |
| `prior-knowledge.json`     | Latest eligible revisions, citations, and review state for incremental catalog maintenance |

The repository archive is pinned to the checkpoint SHA. `evidence.json` includes up to
500 citable Git commit records; the checkpoint commit also includes its changed paths.
Provider evidence includes repository metadata, pull requests, issues, issue comments,
pull-request review comments, and commit discussion comments, subject to the configured
GitHub history bound. Hitting a bound or losing an optional provider source marks the
checkpoint `partial` instead of silently claiming complete coverage.

The default model budget is a 64,000-token context window with compaction at 48,000
tokens and medium reasoning effort:

```text
CONTEXT_CODEX_CONTEXT_TOKENS=64000
CONTEXT_CODEX_COMPACT_TOKENS=48000
CONTEXT_CODEX_EFFORT=medium
CONTEXT_AGENT_ARCHIVE_MAX_BYTES=134217728
```

## Full initialization and incremental updates

On a repository's first build, the agent builds a subject-oriented catalog covering the
supported evidence: architecture, major components, features, decisions, changes,
issues, incidents, ownership, runbooks, and glossary concepts. The output is not limited
to one quotation or a fixed tiny document count; the schema permits 1–50 independently
useful documents.

On a later commit, pull request, or issue update, prior knowledge is the starting catalog.
The agent must:

1. re-emit every still-supported logical document with citations valid at the new
   checkpoint;
2. revise documents affected by the new code or provider history;
3. add newly supported documents; and
4. put every no-longer-supported prior logical ID in `retiredDocuments` with a reason.

The host rejects a catalog that silently drops a prior logical ID, retires an unknown ID,
or both emits and retires the same ID. Re-emission creates immutable revisions at the new
checkpoint; it does not mutate old knowledge.

This incremental contract is important for provider-only changes. A new PR or issue
comment changes the provider evidence digest even when the Git SHA is unchanged. Current
knowledge selection therefore rechecks every citation's source identity and digest
against the exact checkpoint and cannot reuse a stale interpretation merely because
repository/ref/commit match.

## `knowledge-documents-v4`

The v4 output contains `documents` and `retiredDocuments`. Every document has a canonical
logical ID, supported kind, title, summary, Markdown body, scope, confidence, citations,
and a structured summary.

```json
{
  "documents": [
    {
      "logicalId": "runbook:owner/repo:stalled-publication",
      "kind": "runbook",
      "title": "Diagnose a stalled publication",
      "summary": "Check the required projector barrier and outbox age.",
      "summaryCitationOrdinals": [1],
      "bodyMarkdown": "A stalled publication can be caused by an incomplete required projector barrier. [cite:1]",
      "structuredSummary": {
        "facts": [],
        "questionsAnswered": [
          {
            "text": "How should an agent diagnose a stalled publication?",
            "citationOrdinals": [1],
            "confidence": 0.95
          }
        ],
        "diagnostics": {
          "symptoms": [
            {
              "text": "Publication does not advance.",
              "citationOrdinals": [1],
              "confidence": 0.9
            }
          ],
          "causes": [
            {
              "text": "A required projector barrier may be incomplete.",
              "citationOrdinals": [1],
              "confidence": 0.85
            }
          ],
          "checks": [
            {
              "text": "Inspect the required projector barrier and outbox age.",
              "citationOrdinals": [1],
              "confidence": 0.95
            }
          ],
          "fixes": [
            {
              "text": "Replay the idempotent projector delivery.",
              "citationOrdinals": [1],
              "confidence": 0.95
            }
          ]
        },
        "claimSubject": null,
        "claimValue": null,
        "claimCitationOrdinals": []
      },
      "scope": {
        "paths": ["docs/runbook.md"],
        "symbols": [],
        "pullRequests": [],
        "issues": []
      },
      "confidence": 0.9,
      "citations": [
        {
          "claim": "inspect the required projector barrier and outbox age",
          "sourceType": "blob",
          "sourceId": "<blob-sha>",
          "pathOrUrl": "docs/runbook.md",
          "startLine": 20,
          "endLine": 20,
          "jsonPointer": null
        }
      ]
    }
  ],
  "retiredDocuments": []
}
```

Every non-heading body paragraph ends in one or more `[cite:N]` markers. The summary,
facts, questions answered, symptoms, causes, diagnostic checks, fixes, and optional
conflict-comparable claim carry citation ordinals. Derived prose is allowed, but every
citation's `claim` must occur verbatim in its exact inclusive line range or JSON-pointer
value.

The agent may infer a likely issue/change/incident relationship only when multiple cited
signals support it. It must state uncertainty and lower confidence. It may not invent a
diagnostic command or fix absent from repository or provider evidence.

## Host validation and failure behavior

Codex output is untrusted. Before committing any revision, the host:

1. parses the exact v4 schema and rejects graph operations or extra fields;
2. enforces 1–50 documents, supported kinds, confidence bounds, unique logical IDs, and
   the incremental re-emit-or-retire contract;
3. binds tenant, repository, ref, commit, and logical identity to the checkpoint;
4. resolves each source ID, blob, digest, path, exact line range, or JSON pointer from the
   immutable checkpoint;
5. requires each citation claim to occur verbatim in that selected excerpt;
6. validates body markers plus summary and structured-statement citation ordinals;
7. grounds scope and model-controlled logical-ID segments only in resolved citations or
   intrinsic source identity; and
8. writes the derivation run, immutable revisions, citations, and outbox events
   atomically.

The first invalid result gets exactly one repair prompt containing the host diagnostics.
The repair receives the same checkpoint-pinned workspace and must return a complete
catalog. If the repair is invalid, Codex fails, or the checkpoint is stale, derivation
fails closed and writes no knowledge revision. Because derivation is required, the root
build fails; the already-published raw-evidence baseline remains available only for
diagnosis and retry.

## Query, dashboard, and administration

HTTP `POST /context/query` and MCP `query_context` accept `taskKind: "diagnose"`.
Diagnosis routes knowledge, structured provider state, and temporal history together so
agents can retrieve cited symptoms, likely causes, checks, fixes, relevant issues, PRs,
and changes. The response contract remains storage-neutral and expands knowledge
citations to original evidence.

The dashboard knowledge catalog shows distinct logical-document and immutable-revision
counts, generator/model/prompt metadata, prior revision, cited facts and answered
questions, and the four diagnostic groups. Its query workspace exposes `diagnose`.
The tenant admin view shows current logical-document count, revision counts by kind, and
the latest agent/model, review state, confidence, and commit for each visible revision.

## Tests and question-corpus evaluation

The automated API suite covers both repository initialization and an incremental build:
new commit evidence with changed paths, a new pull request, and a new issue/comment are
ingested; prior knowledge is passed to Codex; unchanged documents are re-emitted; and
affected/new documents are committed. The fixture queries the result through HTTP and MCP
`query_context`. Unit tests separately cover explicit retirement validation, schema,
citations, one-repair failure, read-only executor configuration, diagnostic routing, and
incremental catalog rejection. Dashboard/admin builds consume the same public document
contract; deployment acceptance should also inspect both rendered catalog views.

Run the deterministic retrieval gates with:

```sh
pnpm evaluate:context
```

To check a Markdown corpus of real agent questions one by one against a running API, put
questions in bullet lists under optional headings and run:

```sh
JINA_API_URL=https://api.example.com \
JINA_CONTEXT_REPOSITORY=owner/repository \
JINA_CONTEXT_REF=main \
CONTEXT_QUESTION_FILE=/absolute/path/questions.md \
CONTEXT_API_TOKEN='<bound query token>' \
pnpm evaluate:questions > /tmp/context-question-report.json
```

The report preserves every question, category, result (`answered`, `partial`,
`unanswered`, or `error`), answer, citation source IDs, coverage gaps, retrievers, trace
ID, and latency. It also reports category totals, answered-or-partial rate, median, p95,
and maximum latency. Set `CONTEXT_QUESTION_MIN_ANSWERED_RATE` to make the command fail
below a required rate. Treat this as a retrieval/coverage screen: a cited response still
needs semantic grading when the question asks for counterfactual, causal, or fix-quality
judgment.
