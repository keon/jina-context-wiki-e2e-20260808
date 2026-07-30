# Self-hosted PageIndex worker

This bridge uses the MIT-licensed PageIndex Markdown tree implementation pinned
to commit `982514ab40fe42a169ea087c13819cf87c87724f`. It receives only generated,
citation-valid context documents. Raw repository files, provider events,
credentials, tenant policy, and authoritative release state remain in Jina.
Both probe and build verify the exact pinned `page_index_md.py` and `utils.py`
source bytes before doing work. The attested combined SHA-256 is
`b96135e27a2f725971a90ada1c8979d9110d640778bcbdae57b1587f97ffc0a5`;
a differently mounted checkout fails closed even if the bridge still reports
the expected version constant.

Local setup:

```sh
python3.10 -m venv .venv
.venv/bin/pip install -r services/pageindex-worker/requirements.txt
git clone https://github.com/VectifyAI/PageIndex.git .local/PageIndex
git -C .local/PageIndex checkout 982514ab40fe42a169ea087c13819cf87c87724f
PAGEINDEX_SOURCE_ROOT="$PWD/.local/PageIndex" \
CONTEXT_PAGEINDEX_PYTHON="$PWD/.venv/bin/python" \
CONTEXT_PAGEINDEX_WORKER="$PWD/services/pageindex-worker/worker.py" \
pnpm dev
```

Use Python 3.10 or newer. Importing the pinned PageIndex package on Python 3.9
fails because its public client module uses PEP 604 union type syntax at class
definition time.

The worker builds the deterministic tree. Query-time node selection is the
PageIndex-recommended model-based traversal, implemented by the local Codex CLI
selector so the current Codex session can be used without sending private
context to PageIndex Cloud.
