---
name: daily-synthesis
description: Synthesize the local vault into one dated note.
version: 1.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [obsidian, knowledge, automation]
    category: note-taking
    requires_toolsets: [terminal]
---

# Daily synthesis

Use this skill for a scheduled second-brain incubation run.

The knowledge API at `KNOWLEDGE_API_URL` is the only writer for the shared
Obsidian vault. Hermes may receive the raw vault at `OBSIDIAN_VAULT_PATH` for
read-only inspection; never use file tools or shell redirection to mutate it.

Authenticate API calls with `Authorization: Bearer $KNOWLEDGE_API_KEY`. Never
print, quote, log, persist, or put that key in a command argument. Use a short
Python program with standard-library `urllib.request` and read both environment
variables inside the process.

## Procedure

1. Compute today's UTC date as `YYYY-MM-DD`. Read `GET /vault`, `GET
   /nodes?limit=500`, and `GET /graph?limit=1000`.
2. Locally select notes updated today plus a small set of directly connected
   context. Bound detailed `GET /nodes/{id}` reads to 30 notes.
3. Call `POST /connections/discover` with
   `{"limit":10,"min_score":0.36}`. Treat discovered links as hypotheses,
   not facts.
4. Choose at most five useful, non-obvious connections. For each one, state its
   evidence and distinguish an explicit Markdown link from semantic inference.
5. Produce a concise Markdown brief with themes, connection candidates,
   unresolved questions, and at most three graduation candidates. Link each
   referenced vault note using its vault-relative Obsidian link, for example
   `[[inbox/note-name|Readable title]]`; do not link by absolute server path.
6. Create exactly one normal note with `POST /notes`:
   - title: `Daily synthesis — YYYY-MM-DD`
   - tags: `synthesis`, `incubation`
   - `idempotency_key`: `daily-synthesis:YYYY-MM-DD`
   - `permanent`: `false`
7. Count the write as successful only after HTTP 201 returns the expected title,
   `id`, `path`, and `revision`. Report `index_state: pending` honestly; the
   durable Markdown write still succeeded and indexing will retry.

## Conflict and failure rules

- HTTP 409 means the day's idempotency key already exists with a different
  payload. Do not overwrite it or retry with another key. Read the existing
  dated note, report the conflict, and stop.
- Do not edit, promote, move, or delete any source note.
- Do not create a second note after a timeout: repeat the identical request with
  the identical idempotency key.
- Never claim that a synthesis was saved unless the API response confirms it.
