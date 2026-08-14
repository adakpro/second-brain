---
name: inspiration-board
description: Curate a living Pinterest-like inspiration board from the user's HERMESS/Obsidian vault using real notes, memories, insights, tasks, and skills. Use when asked to collect inspiration around a theme, make a moodboard or project board, organize references into visual/editorial clusters, reveal gaps, or save a navigable creative brief.
---

# Inspiration board

Create a navigable knowledge board, not a generic summary.

## Curate

1. Confirm the theme and intended outcome from the request; infer them only when clear.
2. Search the knowledge API broadly, then read full details for at most sixteen strong candidates.
3. Select six to twelve cards with distinct roles. Favor range over near-duplicates:
   - anchors that define the theme;
   - sparks that introduce a different domain;
   - tensions that complicate it;
   - materials such as methods, skills, or tasks;
   - gaps that are not yet represented.
4. Arrange cards into three to five named lanes. Each card gets a one-line reason for belonging, its source kind, and a path-qualified Obsidian link when available.
5. Add a **negative space** section describing what the vault does not yet contain, plus three capture prompts.
6. End with a suggested viewing path: the order in which a person should traverse the board.

## Save a living board

If the user asks to save or create the board, write one editable `kind: note` through `POST /notes` with tags `inspiration-board` and a normalized theme tag. Use a stable idempotency key for retries. Include:

- purpose and current question;
- linked lanes and cards;
- tensions and negative space;
- capture prompts;
- a `Last curated` UTC timestamp.

Use `KNOWLEDGE_API_URL` and `KNOWLEDGE_API_KEY` from the environment. Never print secrets or write directly to `OBSIDIAN_VAULT_PATH`. A later refresh must read the board's current `revision` and send it as `expected_revision`; on 409, stop and offer a merge instead of overwriting an Obsidian edit.

If saving was not requested, return the board in chat without mutating the vault.
