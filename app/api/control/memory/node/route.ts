import { createHash } from "node:crypto";
import { dashboardRequest } from "@/lib/server/hermes-dashboard";
import { profileFromRequest } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";
const memoryId = /^memory:(?:memory|profile):\d+$/;

type JsonRecord = Record<string, unknown>;

function memoryRevision(id: string, content: string) {
  return createHash("sha256").update(id).update("\0").update(content).digest("hex");
}

async function currentMemory(id: string, profile: string) {
  const response = await dashboardRequest(`/api/learning/node?id=${encodeURIComponent(id)}&profile=${encodeURIComponent(profile)}`);
  const value = await response.json().catch(() => null);
  const payload = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  return { response, payload, content: typeof payload.content === "string" ? payload.content : "" };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const profile = profileFromRequest(request);
  if (!memoryId.test(id) || !profile) return Response.json({ detail: "Invalid memory reference" }, { status: 400 });
  try {
    const current = await currentMemory(id, profile);
    if (!current.response.ok) return Response.json({ detail: "Hermes could not load this memory" }, { status: current.response.status });
    return Response.json({
      ok: current.payload.ok === true,
      kind: typeof current.payload.kind === "string" ? current.payload.kind : "memory",
      id,
      label: typeof current.payload.label === "string" ? current.payload.label : id,
      content: current.content,
      revision: memoryRevision(id, current.content),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes memory service is unavailable" }, { status: 503 });
  }
}

export async function PUT() {
  return Response.json({ detail: "Hermes memory content is read-only in HERMESS because upstream IDs are positional" }, { status: 405, headers: { Allow: "GET" } });
}

export async function DELETE() {
  return Response.json({ detail: "Hermes memory content is read-only in HERMESS because upstream IDs are positional" }, { status: 405, headers: { Allow: "GET" } });
}
