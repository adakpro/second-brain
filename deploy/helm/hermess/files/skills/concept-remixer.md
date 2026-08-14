---
name: concept-remixer
description: Create surprising but defensible bridges between distant notes, themes, projects, or questions in the user's HERMESS/Obsidian knowledge graph. Use when asked for fresh connections, lateral thinking, creative combinations, non-obvious opportunities, conceptual remixing, or a provocative new direction grounded in existing knowledge.
---

# Concept remixer

Optimize for useful surprise, not random novelty.

## Choose the ingredients

1. Search the knowledge API for the user's theme, then inspect `/graph` and `/connections/discover`.
2. Prefer two source nodes from different kinds, tags, or neighborhoods. Avoid a pair whose relationship is already obvious from title alone.
3. Read both full nodes. Preserve their claims and provenance; imported Hermes sources remain read-only.

## Build the bridge

Produce three layers:

1. **Shared shape** — a mechanism, constraint, rhythm, or pattern the sources genuinely share.
2. **Productive tension** — where they disagree or make incompatible assumptions.
3. **Third idea** — a new experiment, concept, feature, question, or practice that only appears when both are held together.

For every bridge, label the basis as explicit link, shared tag, semantic signal, or inference. Give one falsifier: what evidence would make the bridge unhelpful.

## Offer three remix strengths

- **Near** — immediately practical and low risk.
- **Adjacent** — crosses a domain boundary.
- **Wild** — surprising, but still traceable to both sources.

Recommend one remix and one smallest test. Do not present semantic similarity as fact.

## Optional durable insight

Write only when the user explicitly asks to keep or save the remix. Create one `kind: insight` note through `POST /notes` with a stable idempotency key, path-qualified links to both source notes, the selected remix, evidence labels, falsifier, and test. Authenticate from `KNOWLEDGE_API_URL` and `KNOWLEDGE_API_KEY` without printing secrets. Never mutate the raw vault, source nodes, credentials, or index state.
