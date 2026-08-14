---
name: obsidian-knowledge
description: Safely read, edit, and manage the shared Markdown vault.
version: 1.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [obsidian, knowledge, notes]
    category: note-taking
    requires_toolsets: [terminal]
---

# Obsidian knowledge vault

Use this skill whenever the user asks Hermes to search, create, edit, or remove notes in
the HERMESS Obsidian vault. The knowledge API is the only writer. The raw path in
`OBSIDIAN_VAULT_PATH`, when present, is deliberately read-only and is never a
mutation target.

The API base URL is `KNOWLEDGE_API_URL`. Authenticate with `Authorization:
Bearer $KNOWLEDGE_API_KEY`. Never print, quote, log, persist, or put the key in a
command argument. Make calls from a short Python standard-library program that
reads both variables from its environment.

## Read and search

1. Start with `GET /vault` to confirm the configured vault label and mutation
   mode. It returns no server filesystem path.
2. Use `GET /search?q=...` for discovery and `GET /nodes/{id}` for the complete
   Markdown plus its current `revision`.
3. Treat `source: vault` nodes with `editable: true` as mutable. Nodes sourced
   from `hermes-skill` or `hermes-memory` are read-only context.
4. Use the returned vault-relative `path` or `obsidian_uri` when referring the
   user to a file. Never invent or reveal an absolute server path.

## Create

1. Prepare Obsidian-compatible Markdown and prefer folder-qualified wikilinks,
   such as `[[projects/retrieval-plan|Retrieval plan]]`.
2. Generate one opaque operation ID and retain it for the whole retry cycle.
   Send it as `idempotency_key` in `POST /notes`; never generate a new key merely
   because the first response timed out.
3. Include a concise title, normalized tag list, content, and intentional
   `permanent` value. The API creates frontmatter and chooses a no-clobber path.
4. Count the operation as successful only after HTTP 201 returns an `id`, `path`,
   and `revision`. A replay returns that same durable node.
5. HTTP 409 means the key was already used for a different payload. Stop and
   surface the conflict; do not work around it with another key.

## Edit

1. Read `GET /nodes/{id}` immediately before editing.
2. Send only intentional changes to `PATCH /notes/{id}` together with the exact
   `expected_revision` just read.
3. On HTTP 409, do not overwrite or blindly retry. Read the latest note, explain
   that Obsidian or another client changed it, and present a merge for user
   approval when the intent is not unambiguous.
4. Read the node back and verify the returned revision/content. If
   `index_state` is `pending`, the Markdown commit succeeded but search/graph
   indexing still needs its automatic retry.

## Promotion and recoverable deletion

- Promote only an editable note with `POST /notes/{id}/promote` and its current
  `expected_revision`.
- Do not mutate imported Hermes skills/memories through note endpoints.
- Delete only after the user explicitly asks to remove a specific node. Read
  `GET /nodes/{id}` immediately first and require `deletable: true`; then send
  `DELETE /nodes/{id}` with JSON `{ "expected_revision": "<latest revision>" }`.
- Count deletion as successful only after the API returns
  `status: "trashed"`, `recovery: "available"`, and a vault-relative
  `trashed_path`. HTTP 409 means the note changed: refresh it and ask again
  when the newer content makes intent ambiguous. A `pending` index state means
  the recoverable move succeeded and reindexing continues asynchronously.
- Never permanently purge Trash, delete through the raw vault mount, or expose
  private recovery paths. Mounted Hermes sources and system-managed knowledge
  are not deletable.
- Never edit `.obsidian`, `.trash`, sync metadata, index state, or credentials.

## Verification

After every mutation, verify `id`, `source`, `editable`, `revision`, `path`, and
the intended content using the API. Never claim success from an HTTP timeout,
from a local draft, or merely because a tool call was attempted.
