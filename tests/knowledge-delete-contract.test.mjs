import assert from "node:assert/strict";
import test from "node:test";

const contract = await import("../components/knowledge-delete-contract.ts");

const revision = "a".repeat(64);

test("only revisioned editable vault nodes expose the Trash workflow", () => {
  const target = {
    id: "my-note",
    title: "My note",
    revision,
    editable: true,
    deletable: true,
    source: "vault",
  };
  assert.equal(contract.canTrashKnowledgeTarget(target), true);
  assert.equal(contract.canTrashKnowledgeTarget({ ...target, editable: false }), false);
  assert.equal(contract.canTrashKnowledgeTarget({ ...target, deletable: false }), false);
  assert.equal(contract.canTrashKnowledgeTarget({ ...target, source: "hermes-skill" }), false);
  assert.equal(contract.canTrashKnowledgeTarget({ ...target, source: "hermes-memory" }), false);
  assert.equal(contract.canTrashKnowledgeTarget({ ...target, revision: "stale" }), false);
  assert.equal(contract.canTrashKnowledgeTarget({ ...target, id: "../../vault" }), false);
});

test("confirmation target is snapshotted before parent props can select another note", () => {
  const mutableTarget = {
    id: "first-note",
    title: "First note",
    path: "inbox/first-note.md",
    revision,
    editable: true,
    deletable: true,
    source: "vault",
  };
  const opened = contract.snapshotKnowledgeDeleteTarget(mutableTarget);
  mutableTarget.id = "next-note";
  mutableTarget.title = "Next note";
  mutableTarget.path = "inbox/next-note.md";
  mutableTarget.revision = "b".repeat(64);

  assert.deepEqual(opened, {
    id: "first-note",
    title: "First note",
    path: "inbox/first-note.md",
    revision,
    editable: true,
    deletable: true,
    source: "vault",
  });
  assert.equal(Object.isFrozen(opened), true);
});

test("accepts only an authoritative recoverable Trash receipt", () => {
  assert.deepEqual(contract.parseKnowledgeDeleteReceipt({
    id: "my-note",
    status: "trashed",
    recovery: "available",
    trashed_path: ".trash/2026/my-note.md",
    original_trashed: true,
    index_state: "pending",
  }), {
    id: "my-note",
    status: "trashed",
    recovery: "available",
    trashedPath: ".trash/2026/my-note.md",
    originalTrashed: true,
    indexState: "pending",
  });

  assert.equal(contract.parseKnowledgeDeleteReceipt({ id: "my-note", status: "deleted" }), null);
  assert.equal(contract.parseKnowledgeDeleteReceipt({
    id: "my-note",
    status: "trashed",
    recovery: "available",
    trashed_path: ".trash/unsafe\\name.md",
    original_trashed: false,
    index_state: "pending",
  }), null);
  assert.equal(contract.parseKnowledgeDeleteReceipt({
    id: "my-note",
    status: "trashed",
    recovery: "available",
    trashed_path: ".trash/2026/my-note.md",
    original_trashed: false,
    index_state: "unknown",
  }), null);
  assert.equal(contract.parseKnowledgeDeleteReceipt({
    id: "my-note",
    status: "trashed",
    recovery: "available",
    original_trashed: false,
    index_state: "ready",
  }), null);
  assert.equal(contract.parseKnowledgeDeleteReceipt({
    id: "my-note",
    status: "trashed",
    recovery: "available",
    trashed_path: "/absolute/private/path",
    original_trashed: false,
    index_state: "ready",
  }), null);
});

test("gives conflict and uncertain failures explicit, non-success copy", () => {
  assert.match(contract.parseKnowledgeDeleteFailure(409, null).detail, /changed/i);
  assert.match(contract.parseKnowledgeDeleteFailure(502, null).detail, /Nothing is shown as deleted/i);
  assert.deepEqual(contract.parseKnowledgeDeleteFailure(429, { detail: "Busy upstream" }), {
    status: 429,
    detail: "Busy upstream",
  });
});
