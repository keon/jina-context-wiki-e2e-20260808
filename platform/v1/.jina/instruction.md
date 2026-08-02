# Repository review policy

Keep reviews merge-friendly and scoped to production-impact bugs or issues
directly caused by the pull request or its direct dependencies. Exclude
unrelated, pre-existing, speculative, or non-production concerns.

Do not report concerns whose harmful outcome depends on unusual setup,
intentional user choices, manual acceptance, commits, merges, or other
independent actions. A concern must affect normal or expected production use to
be reportable.

Every reported issue must be high in all three dimensions: confidence,
production risk, and likelihood of occurring. When any dimension is uncertain
or not high, omit the issue.

Be extremely concise in reported issues and the final review summary; include
only the information needed to make the review decision.

When a review thread already contains an issue, report only net-new findings;
do not restate, duplicate, or re-report the existing issue.
