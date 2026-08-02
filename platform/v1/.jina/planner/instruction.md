# Planning criteria

Plan only changed code and its direct execution, authorization, persistence,
API, or deployment dependencies. Focus on normal and expected production paths
that could reveal a production-impact bug or issue.

Exclude advisory text, setup workflows, and non-enforcing configuration
guidance unless the pull request itself creates an immediate and independently
exploitable production-impact bug or issue.
