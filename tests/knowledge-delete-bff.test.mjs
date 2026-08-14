import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return {
        shortCircuit: true,
        url: new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const server = await import("../lib/server/knowledge-delete.ts");
const route = await import("../app/api/control/knowledge/nodes/[id]/route.ts");

const revision = "b".repeat(64);

function headers(extra = {}) {
  return {
    Host: "hermess.test",
    Origin: "https://hermess.test",
    "Content-Type": "application/json",
    ...extra,
  };
}

function context(id = "mine") {
  return { params: Promise.resolve({ id }) };
}

function request(body = { expected_revision: revision }, extraHeaders = {}) {
  return new Request("https://hermess.test/api/control/knowledge/nodes/mine", {
    method: "DELETE",
    headers: headers(extraHeaders),
    body: JSON.stringify(body),
  });
}

test("delete configuration is server-only and node IDs are constrained", () => {
  const previousUrl = process.env.KNOWLEDGE_API_URL;
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  try {
    process.env.KNOWLEDGE_API_URL = "http://knowledge.internal:8000/";
    process.env.KNOWLEDGE_API_KEY = "private-sidecar-key";
    assert.deepEqual(server.knowledgeDeleteConfig(), {
      baseUrl: "http://knowledge.internal:8000",
      apiKey: "private-sidecar-key",
    });
    assert.equal(server.validKnowledgeNodeId("note:mine-1"), true);
    assert.equal(server.validKnowledgeNodeId("../mine"), false);
    assert.equal(server.validKnowledgeRevision(revision), true);

    process.env.KNOWLEDGE_API_KEY = "bad\nkey";
    assert.equal(server.knowledgeDeleteConfig(), null);
  } finally {
    if (previousUrl === undefined) delete process.env.KNOWLEDGE_API_URL;
    else process.env.KNOWLEDGE_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});

test("BFF rejects cross-origin, invalid IDs, stale/malformed bodies, and excess fields", async () => {
  let response = await route.DELETE(new Request("https://hermess.test/api/control/knowledge/nodes/mine", {
    method: "DELETE",
    headers: headers({ Origin: "https://evil.test" }),
    body: JSON.stringify({ expected_revision: revision }),
  }), context());
  assert.equal(response.status, 403);

  response = await route.DELETE(request(), context("../../vault"));
  assert.equal(response.status, 400);

  response = await route.DELETE(request({ expected_revision: "stale" }), context());
  assert.equal(response.status, 428);

  response = await route.DELETE(request({ expected_revision: revision, permanent: true }), context());
  assert.equal(response.status, 422);

  response = await route.DELETE(request({ expected_revision: revision }, {
    "Content-Length": String(server.MAX_KNOWLEDGE_DELETE_REQUEST_BYTES + 1),
  }), context());
  assert.equal(response.status, 413);
});

test("BFF revision-checks the authenticated internal Trash endpoint without exposing its key", async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = process.env.KNOWLEDGE_API_URL;
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  process.env.KNOWLEDGE_API_URL = "http://knowledge.internal:8000";
  process.env.KNOWLEDGE_API_KEY = "private-sidecar-key";
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return Response.json({
      id: "mine",
      status: "trashed",
      recovery: "available",
      trashed_path: ".trash/2026/mine.md",
      original_trashed: false,
      index_state: "ready",
    });
  };

  try {
    const response = await route.DELETE(request(), context());
    assert.equal(response.status, 200);
    assert.equal(captured.url, "http://knowledge.internal:8000/nodes/mine");
    assert.equal(captured.init.method, "DELETE");
    assert.equal(new Headers(captured.init.headers).get("x-api-key"), "private-sidecar-key");
    assert.deepEqual(JSON.parse(captured.init.body), { expected_revision: revision });
    assert.doesNotMatch(await response.text(), /private-sidecar-key/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.KNOWLEDGE_API_URL;
    else process.env.KNOWLEDGE_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});

test("BFF preserves a conflict signal so the UI refreshes instead of retrying stale state", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  process.env.KNOWLEDGE_API_KEY = "private-sidecar-key";
  globalThis.fetch = async () => Response.json({ detail: "/private/path changed" }, { status: 409 });
  try {
    const response = await route.DELETE(request(), context());
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.match(payload.detail, /refreshed/i);
    assert.doesNotMatch(payload.detail, /private\/path/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});

test("BFF rejects absolute or extra upstream receipt data instead of exposing it", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  process.env.KNOWLEDGE_API_KEY = "private-sidecar-key";
  globalThis.fetch = async () => Response.json({
    id: "mine",
    status: "trashed",
    recovery: "available",
    trashed_path: "/data/private/.trash/mine.md",
    original_trashed: false,
    index_state: "ready",
    internal_debug: "do not expose",
  });
  try {
    const response = await route.DELETE(request(), context());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /data\/private|internal_debug/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});

test("BFF accepts the full shared recovery-path bound", () => {
  const tail = "x".repeat(4096 - ".trash/".length);
  assert.ok(server.normalizeKnowledgeDeleteReceipt({
    id: "mine",
    status: "trashed",
    recovery: "available",
    trashed_path: `.trash/${tail}`,
    original_trashed: false,
    index_state: "pending",
  }, "mine"));
  assert.equal(server.normalizeKnowledgeDeleteReceipt({
    id: "mine",
    status: "trashed",
    recovery: "available",
    trashed_path: `.trash/${tail}x`,
    original_trashed: false,
    index_state: "pending",
  }, "mine"), null);
});
