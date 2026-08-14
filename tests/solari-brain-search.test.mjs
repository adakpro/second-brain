import assert from "node:assert/strict";
import test from "node:test";

const { normalizeSolariBrainSearch } = await import("../lib/solari-brain-search.ts");

test("normalizes the real knowledge SearchHit excerpt contract", () => {
  const results = normalizeSolariBrainSearch([
    {
      score: 0.812345,
      node: {
        id: "note:signal",
        kind: "note",
        title: "Retrieval should explain itself",
        excerpt: "  Useful   evidence from the private vault.  ",
        tags: ["retrieval", "private"],
      },
    },
  ]);

  assert.deepEqual(results, [{
    id: "note:signal",
    title: "Retrieval should explain itself",
    kind: "note",
    summary: "Useful evidence from the private vault.",
    tags: ["retrieval", "private"],
    score: 0.8123,
  }]);
});

test("bounds malformed search output and retains legacy summary fallback", () => {
  const results = normalizeSolariBrainSearch({
    results: [
      null,
      { title: "Legacy source", summary: "Legacy summary", tags: ["ok", 42] },
      { title: "" },
      { title: "Second", content: "Fallback body" },
    ],
  }, 1);

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Legacy source");
  assert.equal(results[0].summary, "Legacy summary");
  assert.deepEqual(results[0].tags, ["ok"]);
});
