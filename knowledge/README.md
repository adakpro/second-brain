# Hermes Knowledge Sidecar

A small, self-contained FastAPI service that turns Markdown notes, Hermes skills,
and Hermes memories into a local semantic index and traversable knowledge graph.
No note content is sent to a remote API.

## What it provides

- Obsidian-compatible Markdown/front matter and `[[wiki links]]`
- safe `obsidian://` deep-links that never expose server filesystem paths
- sentence-transformers embeddings plus FAISS search in the production image
- deterministic, dependency-free hashing/cosine fallback for constrained hosts and tests
- note, skill, memory, insight, and task nodes
- explicit-link, bounded shared-tag, and discovered semantic graph edges
- spreading activation, connection discovery, and permanent-note promotion
- content-hash change detection, stable reads across external saves, and atomic snapshots
- idempotent/no-clobber creates plus Linux exchange-verified conditional updates
- fail-closed `X-API-Key` or bearer authentication and allow-listed CORS

## Run locally

From the repository root, Compose builds and joins both deliberately separate
runtime targets:

```bash
docker compose up --build -d knowledge extractor
```

Release builders can tag the artifacts independently:

```bash
docker build --target knowledge -t hermess-knowledge:local ./knowledge
docker build --target extractor -t hermess-extractor:local ./knowledge
```

The knowledge image contains the local embedding stack and model but no document
parser/OCR libraries. The extractor image contains only the API, bounded document
parsers, PDF renderer, and Tesseract language data; it contains no model weights,
FAISS, torch, vault seeds, or state directory.

The production knowledge image preloads `sentence-transformers/all-MiniLM-L6-v2`; search is
fully local at runtime. For a smaller development image, build with
`--build-arg KNOWLEDGE_PRELOAD_MODEL=false` and set
`KNOWLEDGE_EMBEDDING_BACKEND=hash`.

The bundled notes are copied only into a newly created image/volume location. A
bind mount over `/data/notes` takes precedence, which is normally what you want.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `KNOWLEDGE_API_KEY` | unset | Required secret for every endpoint except health; unset is fail-closed |
| `KNOWLEDGE_ALLOW_INSECURE` | `false` | Explicit development-only auth bypass |
| `KNOWLEDGE_ROOT` | `/data/notes` | Editable Markdown vault |
| `KNOWLEDGE_STATE_DIR` | `/data/state` | Atomic index manifest and FAISS snapshot |
| `KNOWLEDGE_VAULT_NAME` | `HERMESS` | Obsidian vault label used in safe desktop deep-links; never a path |
| `KNOWLEDGE_IGNORED_DIRECTORIES` | `.obsidian,.trash,.git,.hg,.svn,.stfolder` | Exact directory names pruned from scans; all hidden directories are also ignored |
| `KNOWLEDGE_HERMES_HOMES` | unset | Comma-separated Hermes home paths/globs, e.g. `/hermes,/hermes/profiles/*` |
| `KNOWLEDGE_SKILLS_PATHS` | unset | Comma-separated, read-only Hermes skill roots |
| `KNOWLEDGE_MEMORIES_PATHS` | unset | Comma-separated, read-only Hermes memory roots |
| `KNOWLEDGE_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated exact browser origins |
| `KNOWLEDGE_EMBEDDING_BACKEND` | `auto` | `auto`, `sentence-transformers`, or `hash` |
| `KNOWLEDGE_MODEL_NAME` | `sentence-transformers/all-MiniLM-L6-v2` | Local model name/path |
| `KNOWLEDGE_MODEL_REVISION` | pinned commit | Immutable Hugging Face model revision |
| `KNOWLEDGE_MODEL_ALLOW_DOWNLOAD` | `false` | Permit a missing model to download at runtime |
| `KNOWLEDGE_AUTO_INDEX` | `true` | Scan for Markdown changes in the background |
| `KNOWLEDGE_SCAN_INTERVAL_SECONDS` | `60` | Background scan interval |
| `KNOWLEDGE_SEMANTIC_THRESHOLD` | `0.36` | Default discovered-edge threshold |
| `KNOWLEDGE_DOCS_ENABLED` | `false` | Expose `/docs`, `/redoc`, and OpenAPI schema |

`KNOWLEDGE_HERMES_HOMES` is the preferred Hermes integration. From each matched
home the scanner allow-lists only `skills/**/*.md`, `MEMORY.md`, `USER.md`, and
`memories/**/*.md`. It never scans Hermes configuration, databases, sessions,
logs, or authentication files. Root and named-profile nodes receive distinct,
deterministic labels such as `hermes-skills/...` and
`hermes-profile-codex-memories/...`, so same-named `SKILL.md` or `MEMORY.md`
files cannot collide. The two legacy `*_PATHS` settings remain supported.
Explicit IDs inside read-only Hermes sources are also namespaced by that source
label; explicit IDs in the editable vault remain unchanged.

Mount the Hermes state volume read-only so those sources can participate without
allowing the sidecar to mutate Hermes' source of truth, for example:

```yaml
environment:
  KNOWLEDGE_HERMES_HOMES: /hermes-state,/hermes-state/profiles/*
volumes:
  - hermes-data:/hermes-state:ro
```

## Obsidian + Hermes operator workflow

Use one Markdown directory as the authoritative vault. Mount that directory
read-write at `KNOWLEDGE_ROOT` for the knowledge API and read-only at
`OBSIDIAN_VAULT_PATH` inside Hermes. Hermes reads raw Markdown when useful, but
all agent writes—including daily synthesis—must go through the authenticated
knowledge API. This single-writer boundary is what preserves revision checks.
The bundled `obsidian-knowledge` skill encodes this workflow; prefer it over
filesystem-first writing instructions inside the server container.

On a workstation that can access the host filesystem, open the authoritative
directory itself as an Obsidian vault. For a remote server, use one deliberate
filesystem sync or encrypted mount between the workstation vault and that host
directory. Do not layer multiple sync products over the same vault. Take a
snapshot/backup before the first sync and resolve any sync-generated conflict
copies in Obsidian rather than deleting them blindly.

The scanner:

- reads only complete, stable file versions and hashes their actual bytes;
- discovers an external Obsidian save within `KNOWLEDGE_SCAN_INTERVAL_SECONDS`
  (or immediately after authenticated `POST /index`);
- explicitly prunes `.obsidian`, `.trash`, VCS/sync metadata, hidden folders,
  symlinks, and common editor temporary Markdown names;
- never writes Obsidian workspace/plugin configuration.

API-created notes contain a durable `id`. Preserve it when renaming or moving a
note in Obsidian. Notes without an `id` get a deterministic vault-path UUID; add
a unique explicit `id` before renaming if stable identity matters. When copying
a note as a new note, remove or replace its `id` first—two files must not claim
the same explicit ID. A `revision` is the SHA-256 of the exact Markdown bytes.
If Obsidian changes a note after the UI read it, an API update returns HTTP 409
instead of overwriting that edit; refresh, compare, and submit a merged version.
A note with malformed or unterminated YAML remains searchable but is exposed as
`editable: false`; API writes fail closed until its frontmatter is fixed in
Obsidian, preventing a formatter from silently discarding broken properties.

On Linux filesystems that support `renameat2(RENAME_EXCHANGE)`, a conditional
update atomically exchanges the fully synced candidate with the current vault
entry, then hashes the exact displaced bytes. A matching displaced revision is
committed; a mismatch is exchanged back and returns HTTP 409. This closes the
check-then-replace window without requiring Obsidian to honor an application
lock. If a second external save races with rollback, observed external versions
are retained under `KNOWLEDGE_STATE_DIR/write-conflicts` with directory mode
`0700` and file mode `0600` before cleanup. Operators should compare those
copies with the visible vault note and delete them only after resolving the
conflict.

There is deliberately no check-then-replace emulation on platforms or
filesystems without atomic exchange: conditional updates fail closed with HTTP
503 and leave the vault entry unchanged. This is not presented as a universal
multi-host transaction or protection from an uncooperative writer that changes
the same path continuously. API creates remain portable atomic no-clobber
links. Promotion first commits the permanent frontmatter through the same
conditional exchange, then uses an atomic no-clobber move; where that move is
unsupported, the already-permanent note safely remains at its original path.

Recommended Obsidian properties and links:

```markdown
---
id: 01915f76-7b8a-7c44-a93f-d9fd2104b8b1
title: Retrieval should explain itself
aliases:
  - Explainable retrieval
tags:
  - knowledge/retrieval
type: note
permanent: false
---

Connect this to [[permanent/agent-memory|Agent memory]].
```

Folder-qualified wikilinks, aliases, headings, embeds, and percent-encoded
Markdown links resolve deterministically. `GET /vault` returns only the safe
vault label and `obsidian://` URI; node responses add `editable`, a safe
`source` classification, and a vault-relative `obsidian_uri`. Absolute host or
container paths are never returned.

## API tour

`GET /health` and `GET /health/live` are intentionally unauthenticated for
container orchestration. All other routes require `X-API-Key` or
`Authorization: Bearer …`.

```bash
export KNOWLEDGE_URL=http://localhost:8000
export KNOWLEDGE_KEY=replace-with-a-long-random-secret

curl -H "X-API-Key: $KNOWLEDGE_KEY" "$KNOWLEDGE_URL/search?q=local+memory"
curl -H "X-API-Key: $KNOWLEDGE_KEY" "$KNOWLEDGE_URL/graph"
curl -H "X-API-Key: $KNOWLEDGE_KEY" "$KNOWLEDGE_URL/notes"

curl -X POST -H "X-API-Key: $KNOWLEDGE_KEY" -H 'Content-Type: application/json' \
  "$KNOWLEDGE_URL/notes" \
  -d '{"title":"First insight","content":"A local-first second brain compounds.","tags":["principle"]}'
```

Important routes include:

- `GET|POST /search`, `GET /graph`
- `GET /vault` for safe Obsidian metadata (never the server path)
- `GET /nodes`, `/notes`, `/skills`, `/memories`, and `/nodes/{id}`
- `POST /notes`, `PUT|PATCH /notes/{id}`, `POST /notes/{id}/promote`
- `POST /connections/discover`, `GET /nodes/{id}/connections`
- `POST /activation` for spreading activation from one or more seed nodes
- `POST /insights/extract` for fully local, extractive synthesis candidates
- `POST /index`, `GET /stats`

`POST /notes` and `/ingest` accept `note`, `skill`, `memory`, `insight`, and
`task` kinds. Generic node listing, search filters, stats, and graph responses
preserve all five kinds. Graph responses always include explicit references and
degree-bounded shared-tag co-occurrence edges; semantic edges are optional.
Shared-tag candidate work is capped per node and emitted tag edges are capped
globally to keep graph construction predictable for large vaults.

Note updates and promotions require the last `revision` returned by a node read
as `expected_revision`. A stale writer receives HTTP 409 after the displaced
entry is verified and restored; safe conditional-write capability failures
return HTTP 503 without falling back to a racy replacement.

`POST /notes` and `POST /ingest` accept an optional `idempotency_key`. The key is
stored only as a SHA-256 mapping in Markdown. Repeating the identical request
returns the same durable node; reusing the key with a different payload returns
HTTP 409. The final file commit is atomic and no-clobber, so a note created by
Obsidian during filename selection is never replaced.

Create, update, ingest, and promote acknowledge the durable Markdown commit
without waiting for a full-vault embedding pass. Their node response therefore
uses `index_state=pending`; a single coalesced background rebuild converges the
semantic index. Direct node reads and listings use the Markdown authority while
that rebuild is pending, avoiding ambiguous browser timeouts after a commit.

## Recoverable deletion

Authenticated `DELETE /nodes/{id}` accepts a JSON body containing the exact
`expected_revision` returned by the latest node read. Only editable vault
nodes can be deleted; mounted Hermes sources, system-managed seeds, and vault
notes with invalid frontmatter are rejected. The service atomically moves the
exact revision into `.trash/hermess/...` using a no-clobber rename. It never
unlinks the note or overwrites an Obsidian save that races with deletion.

The response contains a vault-relative `trashed_path`, `recovery=available`,
and `index_state=pending`. The live read, search, and graph snapshots receive an
immediate tombstone before the response returns, while one coalesced full index
rebuild continues in the background. The recoverable vault move is already
durable. For imported notes, an unshared private original is moved to private
state trash under the same recovery receipt; shared or unverifiable originals
remain retained and are reported as `original_trashed=false`. Nothing in this
endpoint permanently purges data.

## Document import

`GET /imports/capabilities` reports the authoritative limits and formats.
Authenticated `POST /imports` accepts repeated `files` plus optional
comma-separated `tags` and `target=inbox|permanent`. Supported inputs are
Markdown, UTF-8 text, CSV, JSON, inert HTML, PDF, DOCX, PPTX, XLSX, PNG, JPEG,
WebP, TIFF, and BMP. Images and PDF pages without a text layer use local,
pinned Tesseract OCR with Persian and English language data.

Extraction runs in a separate single-concurrency service with no vault,
knowledge key, deployment secrets, or network egress. Parser work is bounded
by time, CPU, memory, output, archive expansion, PDF pages, spreadsheet cells,
image pixels, and frames. Office macros, external relationships, embedded
objects, active HTML, remote images, Obsidian embeds, Templater, and Dataview
executable forms are rejected or neutralized before Markdown reaches Obsidian.

Raw originals are immutable content-addressed files in private state, never in
the vault or web surface. Derived notes record source filename, normalized MIME,
size, SHA-256, parser version, warnings, and `import_malware_scanned: false`.
This release does not include a malware scanner: import only files you are
authorized to retain. ClamAV/CDR or a larger Docling service is an optional
high-volume tier, not a hidden claim of this deployment.

The visible note batch commits in one atomic no-replace directory rename. A
new durable batch returns `index_state=pending` immediately and joins the
coalesced background index queue; an all-duplicate batch needs no rebuild and
returns `ready`. Content hashes make retrying an uncertain request idempotent.

## Test

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-test.txt
pytest
```
