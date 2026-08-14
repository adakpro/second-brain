import assert from "node:assert/strict";
import test from "node:test";

const contract = await import("../components/knowledge-import-contract.ts");

test("normalizes only an authoritative import capability contract", () => {
  assert.deepEqual(contract.normalizeImportCapabilities({
    max_files: 12,
    max_file_bytes: 8_000_000,
    max_total_bytes: 32_000_000,
    accepted_extensions: ["md", ".PDF", "md"],
    accepted_media_types: ["text/markdown", "application/pdf"],
    malware_scan: false,
  }), {
    maxFiles: 12,
    maxFileBytes: 8_000_000,
    maxTotalBytes: 32_000_000,
    extensions: [".md", ".pdf"],
    mediaTypes: ["text/markdown", "application/pdf"],
    malwareScan: false,
  });

  assert.equal(contract.normalizeImportCapabilities({ max_files: 12 }), null);
});

test("accepts the transactional imported/duplicate result and rejects partial unknown states", () => {
  assert.deepEqual(contract.parseKnowledgeImportBatch({
    results: [
      { filename: "one.md", status: "imported", sha256: "abc", node: { id: "note:one" } },
      { filename: "two.pdf", status: "duplicate", extractor: "pymupdf" },
    ],
    index_state: "pending",
  }), {
    results: [
      { filename: "one.md", status: "imported", sha256: "abc", node: { id: "note:one" }, media_type: undefined, extractor: undefined },
      { filename: "two.pdf", status: "duplicate", sha256: undefined, node: undefined, media_type: undefined, extractor: "pymupdf" },
    ],
    index_state: "pending",
  });

  assert.equal(contract.parseKnowledgeImportBatch({
    results: [{ filename: "unsafe.exe", status: "rejected" }],
  }), null);
});

test("reconciles two same-named files by occurrence without mutating results", () => {
  const results = [
    { filename: "report.pdf", status: "imported", sha256: "first" },
    { filename: "report.pdf", status: "duplicate", sha256: "second" },
  ];
  const frozen = structuredClone(results);
  const reconciled = contract.reconcileImportResults([
    { id: "upload-1", filename: "report.pdf" },
    { id: "upload-2", filename: "report.pdf" },
  ], results);

  assert.equal(reconciled.get("upload-1").sha256, "first");
  assert.equal(reconciled.get("upload-2").sha256, "second");
  assert.deepEqual(results, frozen);
});

test("invokes refresh callback after a confirmed import and preserves the full batch", async () => {
  const batch = {
    results: [
      { filename: "a.md", status: "imported" },
      { filename: "a.md", status: "duplicate" },
    ],
    index_state: "ready",
  };
  let received;
  assert.equal(await contract.notifyKnowledgeImported(batch, (value) => { received = value; }), true);
  assert.equal(received, batch);
  assert.equal(received.results.length, 2);

  let duplicateCallback = false;
  assert.equal(await contract.notifyKnowledgeImported({
    results: [{ filename: "a.md", status: "duplicate" }],
  }, () => { duplicateCallback = true; }), false);
  assert.equal(duplicateCallback, false);
});
