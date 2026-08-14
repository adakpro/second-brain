import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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

const solari = await import("../lib/solari.ts");

test("Solari exposes eight complete guilds and exactly 96 unique roles", () => {
  assert.equal(solari.SOLARI_GUILDS.length, 8);
  assert.equal(solari.solariRoleCount, 96);
  assert.ok(solari.SOLARI_GUILDS.every((guild) => guild.roles.length === 12));
  const ids = solari.SOLARI_GUILDS.flatMap((guild) => guild.roles.map((role) => role.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("the runtime skill registry matches the public role contract", async () => {
  const markdown = await readFile(
    new URL("../config/hermes/skills/solari-orchestrator/references/roles.md", import.meta.url),
    "utf8",
  );
  const documentedIds = [...markdown.matchAll(/^- `([a-z0-9-]+)` —/gm)].map((match) => match[1]);
  const publicIds = solari.SOLARI_GUILDS.flatMap((guild) => guild.roles.map((role) => role.id));
  assert.equal(documentedIds.length, 96);
  assert.deepEqual([...documentedIds].sort(), [...publicIds].sort());
});

test("the Solari profile pins the intended text model and bounded Ultra posture", async () => {
  const config = await readFile(
    new URL("../config/hermes/profiles/solari/config.yaml", import.meta.url),
    "utf8",
  );
  const soul = await readFile(
    new URL("../config/hermes/profiles/solari/SOUL.md", import.meta.url),
    "utf8",
  );
  assert.match(config, /provider:\s*openai-codex/);
  assert.match(config, /default:\s*gpt-5\.6-sol/);
  assert.match(config, /reasoning_effort:\s*ultra/);
  assert.match(soul, /You are Solari/);
  assert.match(soul, /report only workers that actually\s+ran/);
});

test("the generated Solari portrait is packaged as a substantive asset", async () => {
  const portrait = await stat(new URL("../public/solari-portrait.png", import.meta.url));
  assert.ok(portrait.isFile());
  assert.ok(portrait.size > 100_000);
});
