FROM python:3.12-slim

ARG PAGEINDEX_COMMIT=982514ab40fe42a169ea087c13819cf87c87724f

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pageindex-worker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN git clone https://github.com/VectifyAI/PageIndex.git /opt/PageIndex \
    && git -C /opt/PageIndex checkout "${PAGEINDEX_COMMIT}" \
    && rm -rf /opt/PageIndex/.git
COPY worker.py .

ENV PAGEINDEX_SOURCE_ROOT=/opt/PageIndex
RUN python /opt/pageindex-worker/worker.py --probe
USER 65532:65532
ENTRYPOINT ["python", "/opt/pageindex-worker/worker.py"]
