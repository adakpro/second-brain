import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import test, { after, before } from "node:test";

const root = new URL("../", import.meta.url);
const standalone = new URL("../.next/standalone/", import.meta.url);
let baseUrl;
let server;
let serverOutput = "";

async function reservePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert(address && typeof address === "object");
  const { port } = address;
  socket.close();
  await once(socket, "close");
  return port;
}

before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(standalone),
    env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js server exited early (${server.exitCode})\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the Next.js server\n${serverOutput}`);
});

after(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
});

async function request(path, accept = "text/html") {
  return fetch(`${baseUrl}${path}`, { headers: { accept } });
}

test("server-renders the Hermess living digital brain", async () => {
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Solari — Your living digital brain<\/title>/i);
  assert.match(html, /Meet\s*<span>Solari\.<\/span>/);
  assert.match(html, /Talk to Solari/);
  assert.match(html, /96<!-- --> manifest roles/);
  assert.match(html, /Read-only brain search/);
  assert.match(html, /Discover/);
  assert.match(html, /Capabilities/);
  assert.match(html, /DIGITAL BRAIN/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("exposes an unauthenticated container health route", async () => {
  const response = await request("/api/health", "application/json");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).status, "ok");
});

test("removes starter-only assets and keeps secrets server-side", async () => {
  const [page, layout, packageJson, compose, api] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../lib/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /HermessApp/);
  assert.match(layout, /og-digital-brain\.webp/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|site-creator-vinext-starter/);
  assert.match(packageJson, /"d3": "7\.9\.0"/);
  assert.match(compose, /header_up Authorization "Bearer \{\$HERMES_API_KEY\}"|HERMES_API_KEY/);
  assert.doesNotMatch(api, /process\.env\.(HERMES_API_KEY|KNOWLEDGE_API_KEY)/);
  assert.match(api, /graph\?semantic=false&limit=320/);
  assert.match(api, /nodes\?limit=2000/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og-digital-brain.webp", import.meta.url));
  await access(root);
});
