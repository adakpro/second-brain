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

const realtime = await import("../lib/server/solari/realtime.ts");
const route = await import("../app/api/control/solari/realtime/route.ts");
const { SOLARI_SYSTEM_PROMPT } = await import("../lib/solari.ts");

function textStream(value) {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("builds the fixed trusted Solari realtime session", () => {
  const session = realtime.buildRealtimeSession();
  assert.equal(session.type, "realtime");
  assert.equal(session.model, "gpt-realtime-2.1");
  assert.equal(session.audio.output.voice, "marin");
  assert.equal(session.audio.input.transcription.model, "gpt-realtime-whisper");
  assert.equal(session.audio.input.transcription.delay, "low");
  assert.equal(session.audio.input.turn_detection.type, "server_vad");
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(session.instructions, SOLARI_SYSTEM_PROMPT);
  assert.equal(session.tool_choice, "auto");
  assert.deepEqual(session.tools.map((tool) => tool.name), ["search_brain"]);
  assert.equal(session.tools[0].parameters.additionalProperties, false);
  assert.deepEqual(session.tools[0].parameters.required, ["query"]);
});

test("only permits the server model allowlist", () => {
  const previous = process.env.SOLARI_REALTIME_MODEL;
  try {
    process.env.SOLARI_REALTIME_MODEL = "gpt-realtime-2.1-mini";
    assert.equal(realtime.realtimeModel(), "gpt-realtime-2.1-mini");
    assert.equal(realtime.buildRealtimeSession().model, "gpt-realtime-2.1-mini");

    process.env.SOLARI_REALTIME_MODEL = "arbitrary-client-model";
    assert.equal(realtime.realtimeModel(), "gpt-realtime-2.1");

    delete process.env.SOLARI_REALTIME_MODEL;
    assert.equal(realtime.realtimeModel(), "gpt-realtime-2.1");
  } finally {
    if (previous === undefined) delete process.env.SOLARI_REALTIME_MODEL;
    else process.env.SOLARI_REALTIME_MODEL = previous;
  }
});

test("realtime key file configuration fails closed outside the secret mount", async () => {
  const previousPath = process.env.OPENAI_REALTIME_API_KEY_FILE;
  const previousKey = process.env.OPENAI_REALTIME_API_KEY;
  try {
    process.env.OPENAI_REALTIME_API_KEY_FILE = "/tmp/not-an-allowed-secret";
    process.env.OPENAI_REALTIME_API_KEY = "must-not-fall-back";
    assert.equal(await realtime.realtimeApiKey(), "");
  } finally {
    if (previousPath === undefined) delete process.env.OPENAI_REALTIME_API_KEY_FILE;
    else process.env.OPENAI_REALTIME_API_KEY_FILE = previousPath;
    if (previousKey === undefined) delete process.env.OPENAI_REALTIME_API_KEY;
    else process.env.OPENAI_REALTIME_API_KEY = previousKey;
  }
});

test("uses a stable opaque server-side safety identifier", () => {
  const previousSecret = process.env.SOLARI_SAFETY_IDENTIFIER_SECRET;
  const previousPrincipal = process.env.SOLARI_SAFETY_PRINCIPAL;
  process.env.SOLARI_SAFETY_IDENTIFIER_SECRET = "test-only-safety-secret";
  process.env.SOLARI_SAFETY_PRINCIPAL = "private-test-operator";
  try {
    const first = realtime.buildSafetyIdentifier("unused-test-api-key");
    const second = realtime.buildSafetyIdentifier("unused-test-api-key");
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.ok(!first.includes("operator"));
    assert.ok(!first.includes("api-key"));
  } finally {
    if (previousSecret === undefined) delete process.env.SOLARI_SAFETY_IDENTIFIER_SECRET;
    else process.env.SOLARI_SAFETY_IDENTIFIER_SECRET = previousSecret;
    if (previousPrincipal === undefined) delete process.env.SOLARI_SAFETY_PRINCIPAL;
    else process.env.SOLARI_SAFETY_PRINCIPAL = previousPrincipal;
  }
});

test("bounds SDP bodies before accumulating them", async () => {
  const valid = "v=0\r\ns=-\r\n";
  assert.equal(
    await realtime.readBoundedText(textStream(valid), new Headers(), realtime.MAX_SDP_REQUEST_BYTES),
    valid,
  );

  await assert.rejects(
    realtime.readBoundedText(
      textStream("ignored"),
      new Headers({ "Content-Length": String(realtime.MAX_SDP_REQUEST_BYTES + 1) }),
      realtime.MAX_SDP_REQUEST_BYTES,
    ),
    realtime.BodyLimitError,
  );
});

test("enforces bounded concurrent realtime initialization", () => {
  const now = Date.now();
  const first = realtime.acquireRealtimeCapacity(now);
  const second = realtime.acquireRealtimeCapacity(now);
  const third = realtime.acquireRealtimeCapacity(now);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(third, { ok: false, retryAfterSeconds: 2 });
  if (first.ok) first.release();
  if (second.ok) second.release();
});

test("sends multipart SDP and trusted session configuration upstream", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedInit;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response("v=0\r\ns=-\r\n", {
      status: 201,
      headers: { "Content-Type": "application/sdp" },
    });
  };

  try {
    const result = await realtime.createRealtimeCall("v=0\r\ns=offer\r\n", "test-api-key");
    assert.equal(result.ok, true);
    assert.equal(capturedUrl, "https://api.openai.com/v1/realtime/calls");
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.cache, "no-store");

    const headers = new Headers(capturedInit.headers);
    assert.equal(headers.get("authorization"), "Bearer test-api-key");
    assert.match(headers.get("openai-safety-identifier") ?? "", /^[a-f0-9]{64}$/);
    assert.ok(capturedInit.body instanceof FormData);
    assert.equal(capturedInit.body.get("sdp"), "v=0\r\ns=offer\r\n");
    assert.deepEqual(JSON.parse(capturedInit.body.get("session")), realtime.buildRealtimeSession());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("route is fail-closed, same-origin, and strict about SDP", async () => {
  const previousEnabled = process.env.SOLARI_REALTIME_ENABLED;
  const previousKey = process.env.OPENAI_REALTIME_API_KEY;
  const previousKeyFile = process.env.OPENAI_REALTIME_API_KEY_FILE;
  try {
    delete process.env.OPENAI_REALTIME_API_KEY_FILE;
    process.env.SOLARI_REALTIME_ENABLED = "false";
    delete process.env.OPENAI_REALTIME_API_KEY;
    let response = await route.GET();
    assert.deepEqual(await response.json(), {
      enabled: false,
      configured: false,
      model: "gpt-realtime-2.1",
      voice: "marin",
    });
    assert.equal(response.headers.get("cache-control"), "no-store");

    response = await route.POST(new Request("https://hermess.test/api/control/solari/realtime", {
      method: "POST",
      headers: { Host: "hermess.test", Origin: "https://hermess.test", "Content-Type": "application/sdp" },
      body: "v=0\r\ns=-\r\n",
    }));
    assert.equal(response.status, 503);

    process.env.SOLARI_REALTIME_ENABLED = "true";
    process.env.OPENAI_REALTIME_API_KEY = "test-api-key";
    response = await route.POST(new Request("https://hermess.test/api/control/solari/realtime", {
      method: "POST",
      headers: { Host: "hermess.test", Origin: "https://evil.test", "Content-Type": "application/sdp" },
      body: "v=0\r\ns=-\r\n",
    }));
    assert.equal(response.status, 403);

    response = await route.POST(new Request("https://hermess.test/api/control/solari/realtime", {
      method: "POST",
      headers: { Host: "hermess.test", Origin: "https://hermess.test", "Content-Type": "text/plain" },
      body: "v=0\r\ns=-\r\n",
    }));
    assert.equal(response.status, 415);

    response = await route.POST(new Request("https://hermess.test/api/control/solari/realtime", {
      method: "POST",
      headers: { Host: "hermess.test", Origin: "https://hermess.test", "Content-Type": "application/sdp" },
      body: "not-sdp",
    }));
    assert.equal(response.status, 400);
  } finally {
    if (previousEnabled === undefined) delete process.env.SOLARI_REALTIME_ENABLED;
    else process.env.SOLARI_REALTIME_ENABLED = previousEnabled;
    if (previousKey === undefined) delete process.env.OPENAI_REALTIME_API_KEY;
    else process.env.OPENAI_REALTIME_API_KEY = previousKey;
    if (previousKeyFile === undefined) delete process.env.OPENAI_REALTIME_API_KEY_FILE;
    else process.env.OPENAI_REALTIME_API_KEY_FILE = previousKeyFile;
  }
});
