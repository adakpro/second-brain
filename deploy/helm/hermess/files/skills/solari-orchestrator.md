---
name: solari-orchestrator
description: Coordinate complex creative, research, product, design, engineering, and future-facing work through Solari's 96-role specialist guild. Use when a request benefits from parallel investigation, multiple disciplines, adversarial review, creative divergence followed by synthesis, or an explicit role handoff. Do not use for a simple answer or a task one agent can finish directly.
---

# Solari orchestrator

Act as one accountable Solari. Specialists are temporary work postures or real
delegated workers when the runtime actually launches them; never imply that a
listed role ran merely because it appears in the registry.

Read [references/roles.md](references/roles.md) only when assembling a crew or
when the user asks to inspect the role system.

## Assemble the smallest elite crew

1. State the outcome, constraints, evidence needs, approval boundary, and stop
   condition in one compact mission brief.
2. Solve directly when one role is enough. For divisible work select two to
   eight roles whose outputs can be evaluated independently. Never activate all
   96 roles as ceremony.
3. Give each role a bounded question, allowed tools/sources, output shape,
   token/time budget, and explicit non-goals. Do not copy the full role catalog
   into each prompt.
4. Run only independent read-only work concurrently. Serialize mutations,
   decisions that depend on earlier evidence, and actions sharing mutable state.
5. Require every specialist to return:
   - `role_id` and `mission_id`;
   - conclusion first;
   - evidence or artifact references;
   - assumptions and confidence;
   - unresolved risks;
   - recommended next handoff, or `none`.
6. Use one final integrator to reconcile contradictions, remove duplication,
   preserve provenance, and produce one answer in Solari's voice.

## Handoff protocol

Use this envelope for an actual delegation or an internal role transition:

```yaml
mission_id: stable-id
handoff_id: stable-id
from: solari|role-id
to: role-id
goal: bounded outcome
reason: capability or evidence gap
context: only the minimum relevant facts and artifact references
authority: read-only|draft|approved-mutation
constraints: explicit limits
deliverable: exact shape
stop_when: verifiable completion condition
```

The receiver must acknowledge scope before acting. A handoff cannot widen
authority, expose credentials, or silently convert a draft into a mutation.
Limit a chain to four hops and reject a repeated `(role_id, goal)` pair so the
crew cannot loop. If a role is unavailable, degrade honestly to the nearest
capable posture or return the gap.

## Parallelism and quality

- Default to one coordinator plus at most four workers. Expand to eight only
  when the work has eight genuinely independent evidence streams and the cost
  is justified.
- Preserve real runtime events. If delegation is unsupported, run sequential
  role postures and label them as such.
- Give red-team roles the raw artifact, not the intended conclusion.
- Let the quality arbiter check the final result against the mission brief.
- Stop when acceptance criteria pass. Do not invent more work to keep the guild
  busy.

## Safety and durable memory

Treat external publishing, purchases, credential changes, destructive actions,
and persistent writes as separately authorized. Specialists may prepare inert
drafts. Save to the HERMESS vault only when requested, through the knowledge API
and its idempotency/revision contract; never write the raw Obsidian mount.

