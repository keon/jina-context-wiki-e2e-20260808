FROM mirror.gcr.io/library/node:26-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install -g pnpm@11.15.1

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @jina/worker... build \
  && pnpm --filter @jina/worker deploy --prod --legacy /out

FROM mirror.gcr.io/library/node:22-bookworm-slim AS pageindex

ARG PAGEINDEX_COMMIT=982514ab40fe42a169ea087c13819cf87c87724f

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
COPY services/pageindex-worker/requirements.txt /tmp/pageindex-requirements.txt
COPY services/pageindex-worker/worker.py /opt/pageindex-worker/worker.py
RUN python3 -m venv /opt/pageindex-venv \
  && /opt/pageindex-venv/bin/pip install --no-cache-dir -r /tmp/pageindex-requirements.txt \
  && git clone https://github.com/VectifyAI/PageIndex.git /opt/PageIndex \
  && git -C /opt/PageIndex checkout "${PAGEINDEX_COMMIT}" \
  && rm -rf /opt/PageIndex/.git \
  && PAGEINDEX_SOURCE_ROOT=/opt/PageIndex \
    /opt/pageindex-venv/bin/python /opt/pageindex-worker/worker.py --probe

# Board snapshot workers need git and tar. The PageIndex role also executes the
# pinned local Python bridge in-process; no repository bytes leave this image
# for a hosted PageIndex service.
FROM mirror.gcr.io/library/node:26-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git tar python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=pageindex --chown=node:node /opt/pageindex-venv /opt/pageindex-venv
COPY --from=pageindex --chown=node:node /opt/PageIndex /opt/PageIndex
COPY --chown=node:node services/pageindex-worker/worker.py /opt/pageindex-worker/worker.py
COPY --chown=node:node scripts/context-production-preflight.mjs /opt/jina/context-production-preflight.mjs
COPY --chown=node:node scripts/context-production-trigger-e2e.mjs /opt/jina/context-production-trigger-e2e.mjs

ENV NODE_ENV=production
ENV PORT=8080
ENV CONTEXT_PAGEINDEX_PYTHON=/opt/pageindex-venv/bin/python
ENV CONTEXT_PAGEINDEX_WORKER=/opt/pageindex-worker/worker.py
ENV PAGEINDEX_SOURCE_ROOT=/opt/PageIndex
EXPOSE 8080
USER node

CMD ["node", "dist/server.js"]
