import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const { completedSolariFunctionCalls } = await import("../lib/solari-realtime-events.ts");

const call = {
  id: "item_1",
  type: "function_call",
  status: "completed",
  name: "search_brain",
  call_id: "call_1",
  arguments: JSON.stringify({ query: "design principles" }),
};

test("releases function calls only from a completed terminal response", () => {
  assert.deepEqual(completedSolariFunctionCalls({
    type: "response.done",
    response: { status: "completed", output: [call] },
  }), [{
    callId: "call_1",
    name: "search_brain",
    argumentsText: JSON.stringify({ query: "design principles" }),
  }]);
});

test("never executes argument events or cancelled and incomplete responses", () => {
  assert.deepEqual(completedSolariFunctionCalls({
    type: "response.function_call_arguments.done",
    name: "search_brain",
    call_id: "call_1",
    arguments: call.arguments,
  }), []);
  for (const status of ["cancelled", "failed", "incomplete", "in_progress"]) {
    assert.deepEqual(completedSolariFunctionCalls({
      type: "response.done",
      response: { status, output: [call] },
    }), []);
  }
  assert.deepEqual(completedSolariFunctionCalls({
    type: "response.done",
    response: { status: "completed", output: [{ ...call, status: "incomplete" }] },
  }), []);
});

test("bounds malformed and oversized function-call items", () => {
  const output = Array.from({ length: 12 }, (_, index) => ({
    ...call,
    call_id: `call_${index}`,
  }));
  assert.equal(completedSolariFunctionCalls({
    type: "response.done",
    response: { status: "completed", output },
  }).length, 8);
  assert.deepEqual(completedSolariFunctionCalls({
    type: "response.done",
    response: { status: "completed", output: [{ ...call, arguments: "x".repeat(4_097) }] },
  }), []);
});

test("the voice client invalidates outstanding tools on a newer speech turn", async () => {
  const source = await readFile(
    new URL("../components/solari-experience.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(type === "input_audio_buffer\.speech_started"\) \{\s*interruptBrainSearches\(\)/);
  assert.match(source, /toolEpoch !== toolEpochRef\.current/);
  assert.match(source, /Math\.max\(0, 2 - toolRequestsRef\.current\.size\)/);
  assert.match(source, /if \(toolRequestsRef\.current\.size\) interruptBrainSearches\(\)/);
});
