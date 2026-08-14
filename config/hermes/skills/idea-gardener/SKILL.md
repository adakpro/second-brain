---
name: idea-gardener
description: Grow a rough thought, captured fragment, unresolved question, or early project idea into several useful directions connected to the user's Obsidian knowledge. Use for requests to brainstorm without losing provenance, develop an idea, find implications, challenge an assumption, or save an emerging insight into the shared HERMESS vault.
---

# Idea gardener

Keep the original thought visible. Expand it without prematurely collapsing it into one polished answer.

## Grow the idea

1. Restate the fragment in one sentence without making it sound more certain than it is.
2. Search the knowledge API at `KNOWLEDGE_API_URL` for the important nouns and claims. Authenticate with `Authorization: Bearer $KNOWLEDGE_API_KEY`; read both values from the environment and never print the key.
3. Read full details for at most eight relevant nodes. Prefer editable vault notes as evidence; treat imported Hermes memories and skills as read-only context.
4. Develop four branches:
   - **Possibility** — the most generative extension.
   - **Tension** — an assumption, contradiction, or cost.
   - **Application** — a concrete experiment or artifact.
   - **Question** — what would make the idea meaningfully different.
5. Add up to three vault connections. For each, distinguish a Markdown link, shared tag, semantic resemblance, and your own inference.
6. End with one small next move that can be completed in under thirty minutes.

## Save only intentional work

- If the user asks to save, plant, capture, or remember the result, create one `kind: insight` note through `POST /notes`—never through the raw `OBSIDIAN_VAULT_PATH` mount.
- Use a stable idempotency key for the whole retry cycle. Include the unedited original fragment, the four branches, evidence links, open questions, and the next move.
- Use folder-qualified Obsidian links from API-provided paths. Never expose an absolute server path.
- Count the write as successful only after HTTP 201 returns `id`, `path`, and `revision`. Repeat an identical timed-out request with the same idempotency key.
- On 409, read the current note and surface the conflict. Never overwrite, delete, or invent a new retry key merely to bypass it.

If the user asked only to explore, return the garden in chat and do not write anything.
