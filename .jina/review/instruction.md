# Summary and merge scoring

Keep merge readiness friendly to changes without a confirmed production-impact
bug or issue. Use 5/5 as the default when no reportable issue is confirmed.

Use 4/5 for a confirmed concern that merits follow-up but is safe to merge. Use
3/5 only for a serious, well-evidenced production-impact bug or issue that
should be resolved before a normal release. Use 2/5 or 1/5 only when the pull
request would catastrophically bring production down entirely.

Do not reduce merge readiness based solely on speculative concerns or concerns
that require unusual setup, intentional user choices, manual acceptance,
commits, merges, or other independent actions.
