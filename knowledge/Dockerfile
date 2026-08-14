# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS application-base

ARG PIP_VERSION=26.2.1
ARG SETUPTOOLS_VERSION=84.0.0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/knowledge

COPY requirements-core.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://pypi.org/simple \
      "pip==${PIP_VERSION}" "setuptools==${SETUPTOOLS_VERSION}" \
    && pip install --index-url https://pypi.org/simple -r requirements-core.txt

COPY app ./app

RUN groupadd --system --gid 10001 knowledge \
    && useradd --system --uid 10001 --gid knowledge \
      --home-dir /srv/knowledge knowledge \
    && chown -R knowledge:knowledge /srv/knowledge \
    && chmod -R a=rX /srv/knowledge/app


# Parser-only runtime. It deliberately contains no torch, FAISS, transformers,
# embedding model, vault seed, or state directory. Deployment isolation supplies
# a read-only root, bounded /tmp, no secrets, and no network egress.
FROM application-base AS extractor

ARG TESSERACT_VERSION=5.5.0-1+b1
ARG TESSDATA_VERSION=1:4.1.0-2

USER 0:0

COPY requirements-extractor.txt ./
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      "tesseract-ocr=${TESSERACT_VERSION}" \
      "tesseract-ocr-eng=${TESSDATA_VERSION}" \
      "tesseract-ocr-fas=${TESSDATA_VERSION}" \
    && tesseract --list-langs 2>&1 | grep -qx eng \
    && tesseract --list-langs 2>&1 | grep -qx fas \
    && rm -rf /var/lib/apt/lists/*

# Keep Python dependency installation in its own BuildKit cache-aware layer;
# requirements-extractor includes the already-installed core contract. The
# immutable runtime never installs packages, so remove pip and its vendored
# SBOM after validating the environment.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://pypi.org/simple -r requirements-extractor.txt \
    && python -m pip check \
    && rm -rf /usr/local/lib/python3.12/site-packages/pip \
      /usr/local/lib/python3.12/site-packages/pip-*.dist-info \
    && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12

ENV TMPDIR=/tmp

USER 10001:10001
EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/health/ready', timeout=3)" || exit 1

CMD ["uvicorn", "app.extractor_api:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1", "--no-access-log"]


# Vault writer and local semantic index. Heavy model dependencies and immutable
# weights exist only in this trusted service image, never in the parser runtime.
FROM application-base AS knowledge

ARG KNOWLEDGE_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
ARG KNOWLEDGE_MODEL_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
ARG KNOWLEDGE_PRELOAD_MODEL=true
ARG PYTORCH_CPU_VERSION=2.13.0+cpu

ENV HF_HOME=/opt/models \
    SENTENCE_TRANSFORMERS_HOME=/opt/models \
    KNOWLEDGE_ROOT=/data/notes \
    KNOWLEDGE_STATE_DIR=/data/state \
    TMPDIR=/data/state/import-spool \
    KNOWLEDGE_EXTRACTOR_URL=http://extractor:8010 \
    KNOWLEDGE_MODEL_NAME=${KNOWLEDGE_MODEL_NAME} \
    KNOWLEDGE_MODEL_REVISION=${KNOWLEDGE_MODEL_REVISION} \
    KNOWLEDGE_MODEL_ALLOW_DOWNLOAD=false

USER 0:0

COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/cpu \
      "torch==${PYTORCH_CPU_VERSION}" \
    && pip install --index-url https://pypi.org/simple -r requirements.txt

# Bake model weights into the image so production search has no runtime cloud
# dependency. Set KNOWLEDGE_PRELOAD_MODEL=false for a hash-fallback image. Pip
# is then removed because package installation is a build-only concern.
RUN if [ "$KNOWLEDGE_PRELOAD_MODEL" = "true" ]; then \
      python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${KNOWLEDGE_MODEL_NAME}', revision='${KNOWLEDGE_MODEL_REVISION}')"; \
    fi \
    && python -m pip check \
    && rm -rf /usr/local/lib/python3.12/site-packages/pip \
      /usr/local/lib/python3.12/site-packages/pip-*.dist-info \
    && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12

# Runtime retrieval is intentionally offline; the immutable model snapshot is
# already present in HF_HOME from the build step above.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1

COPY notes /opt/bootstrap-notes

RUN mkdir -p /data/notes /data/state /opt/models \
    && cp -R /opt/bootstrap-notes/. /data/notes/ \
    && chown -R knowledge:knowledge /data /srv/knowledge /opt/models \
    && chmod -R a=rX /opt/bootstrap-notes /opt/models

USER 10001:10001
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
