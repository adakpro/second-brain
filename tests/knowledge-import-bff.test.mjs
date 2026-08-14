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

const server = await import("../lib/server/knowledge-import.ts");
const route = await import("../app/api/control/knowledge/import/route.ts");

function sameOriginHeaders(extra = {}) {
  return {
    Host: "hermess.test",
    Origin: "https://hermess.test",
    ...extra,
  };
}

test("validates a real multipart boundary and server-only configuration", () => {
  const previousUrl = process.env.KNOWLEDGE_API_URL;
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  try {
    process.env.KNOWLEDGE_API_URL = "http://knowledge.internal:8000/";
    process.env.KNOWLEDGE_API_KEY = "secret-sidecar-key";
    assert.deepEqual(server.knowledgeImportConfig(), {
      baseUrl: "http://knowledge.internal:8000",
      apiKey: "secret-sidecar-key",
    });
    assert.equal(server.multipartBoundary("multipart/form-data; boundary=----browser"), "----browser");
    assert.equal(server.multipartBoundary("application/json"), null);

    process.env.KNOWLEDGE_API_KEY = "bad\nkey";
    assert.equal(server.knowledgeImportConfig(), null);
  } finally {
    if (previousUrl === undefined) delete process.env.KNOWLEDGE_API_URL;
    else process.env.KNOWLEDGE_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});

test("capability route authenticates server-side and never exposes the sidecar key", async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = process.env.KNOWLEDGE_API_URL;
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  let captured;
  process.env.KNOWLEDGE_API_URL = "http://knowledge.internal:8000";
  process.env.KNOWLEDGE_API_KEY = "secret-sidecar-key";
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return Response.json({
      max_files: 10,
      max_file_bytes: 1_000,
      max_total_bytes: 5_000,
      accepted_extensions: [".md"],
      accepted_media_types: ["text/markdown"],
    });
  };

  try {
    const response = await route.GET();
    assert.equal(response.status, 200);
    assert.equal(captured.url, "http://knowledge.internal:8000/imports/capabilities");
    assert.equal(new Headers(captured.init.headers).get("x-api-key"), "secret-sidecar-key");
    assert.doesNotMatch(await response.text(), /secret-sidecar-key/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.KNOWLEDGE_API_URL;
    else process.env.KNOWLEDGE_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});

test("import route requires same-origin multipart and rejects oversized declared bodies before proxying", async () => {
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  process.env.KNOWLEDGE_API_KEY = "server-only";
  try {
    let response = await route.POST(new Request("https://hermess.test/api/control/knowledge/import", {
      method: "POST",
      headers: sameOriginHeaders({ Origin: "https://evil.test", "Content-Type": "multipart/form-data; boundary=x" }),
      body: "--x--\r\n",
    }));
    assert.equal(response.status, 403);

    response = await route.POST(new Request("https://hermess.test/api/control/knowledge/import", {
      method: "POST",
      headers: sameOriginHeaders({ "Content-Type": "application/json" }),
      body: "{}",
    }));
    assert.equal(response.status, 415);

    response = await route.POST(new Request("https://hermess.test/api/control/knowledge/import", {
      method: "POST",
      headers: sameOriginHeaders({
        "Content-Type": "multipart/form-data; boundary=x",
        "Content-Length": String(server.knowledgeImportProxyLimit() + 1),
      }),
      body: "--x--\r\n",
    }));
    assert.equal(response.status, 413);
  } finally {
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});

test("streams repeated files to the authenticated internal endpoint and returns the bounded result", async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = process.env.KNOWLEDGE_API_URL;
  const previousKey = process.env.KNOWLEDGE_API_KEY;
  process.env.KNOWLEDGE_API_URL = "http://knowledge.internal:8000";
  process.env.KNOWLEDGE_API_KEY = "server-only-key";
  let capturedBody = "";
  let capturedHeaders;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "http://knowledge.internal:8000/imports");
    capturedHeaders = new Headers(init.headers);
    capturedBody = await new Response(init.body).text();
    return Response.json({
      results: [
        { filename: "same.md", status: "imported", sha256: "a", extractor: "markdown" },
        { filename: "same.md", status: "duplicate", sha256: "a", extractor: "markdown" },
      ],
      index_state: "ready",
    }, { status: 201 });
  };

  try {
    const form = new FormData();
    form.append("files", new File(["# first"], "same.md", { type: "text/markdown" }));
    form.append("files", new File(["# first"], "same.md", { type: "text/markdown" }));
    form.set("target", "inbox");
    const incoming = new Request("https://hermess.test/api/control/knowledge/import", {
      method: "POST",
      headers: sameOriginHeaders(),
      body: form,
    });
    const response = await route.POST(incoming);
    assert.equal(response.status, 201);
    assert.equal(capturedHeaders.get("x-api-key"), "server-only-key");
    assert.match(capturedHeaders.get("content-type"), /^multipart\/form-data; boundary=/);
    assert.match(capturedBody, /name="files"; filename="same\.md"/);
    assert.match(capturedBody, /name="target"/);
    assert.doesNotMatch(await response.text(), /server-only-key/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.KNOWLEDGE_API_URL;
    else process.env.KNOWLEDGE_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = previousKey;
  }
});
