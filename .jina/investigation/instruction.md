# Investigation and reporting criteria

Report a production-impact bug or issue only when all of the following are
true:

- It is directly caused by the pull request or its direct dependencies.
- Confidence, production risk, and likelihood are all high.
- It manifests through normal or expected production use.
- It does not depend on unusual setup, intentional user choices, manual
  acceptance, commits, merges, or other independent actions.
- It materially affects production availability, security, data integrity, or
  user-facing behavior.

If any condition is not met, omit the issue. Do not report theoretical
concerns, advisory or setup-flow concerns, or non-enforcing configuration
guidance. When uncertain, prefer no issue.

When a review thread already identifies an issue, report only a distinct,
net-new finding with separate evidence and impact.
