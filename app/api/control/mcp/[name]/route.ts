import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, readObjectBody } from "@/lib/server/control-input";
import { mcpRevision, serializeMcpMutation, serversWithRevisions } from "@/lib/server/mcp-revision";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ name: string }> };

export async function PATCH(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { name } = await context.params;
  const input = await readObjectBody(request);
  if (!identifierPattern.test(name) || typeof input?.enabled !== "boolean") {
    return Response.json({ detail: "A valid server and enabled state are required" }, { status: 422 });
  }
  const profile = typeof input.profile === "string" && identifierPattern.test(input.profile) ? input.profile : "default";
  const expectedRevision = typeof input.expected_revision === "string" ? input.expected_revision : "";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return Response.json({ detail: "Refresh this MCP server before changing it" }, { status: 428 });
  return serializeMcpMutation(async () => {
    const current = await currentServer(name, profile);
    if (current.error) return current.error;
    if (mcpRevision(profile, current.server) !== expectedRevision) return Response.json({ detail: "This MCP server changed. Refresh before updating it." }, { status: 409 });
    try {
      const upstream = await dashboardRequest(`/api/mcp/servers/${encodeURIComponent(name)}/enabled?profile=${encodeURIComponent(profile)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: input.enabled, profile }),
      });
      const payload = await upstream.json().catch(() => null);
      return upstream.ok ? Response.json(payload, { headers: { "Cache-Control": "no-store" } }) : Response.json({ detail: "Hermes could not update this MCP server" }, { status: upstream.status });
    } catch {
      return Response.json({ detail: "Hermes MCP service is unavailable" }, { status: 503 });
    }
  });
}

export async function DELETE(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { name } = await context.params;
  if (!identifierPattern.test(name)) return Response.json({ detail: "Invalid server name" }, { status: 400 });
  const profile = profileFromUrl(request);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  const input = await readObjectBody(request);
  const expectedRevision = typeof input?.expected_revision === "string" ? input.expected_revision : "";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return Response.json({ detail: "Refresh this MCP server before deleting it" }, { status: 428 });
  return serializeMcpMutation(async () => {
    const current = await currentServer(name, profile);
    if (current.error) return current.error;
    if (mcpRevision(profile, current.server) !== expectedRevision) return Response.json({ detail: "This MCP server changed. Refresh before deleting it." }, { status: 409 });
    try {
      const upstream = await dashboardRequest(`/api/mcp/servers/${encodeURIComponent(name)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" });
      if (!upstream.ok) return Response.json({ detail: "Hermes could not delete this MCP server" }, { status: upstream.status });
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ detail: "Hermes MCP service is unavailable" }, { status: 503 });
    }
  });
}

function profileFromUrl(request: Request) {
  const value = new URL(request.url).searchParams.get("profile") || "default";
  return identifierPattern.test(value) ? value : null;
}

async function currentServer(name: string, profile: string): Promise<{ server: Record<string, unknown>; error?: never } | { server?: never; error: Response }> {
  try {
    const upstream = await dashboardRequest(`/api/mcp/servers?profile=${encodeURIComponent(profile)}`);
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) return { error: Response.json({ detail: "Hermes could not reload MCP servers" }, { status: upstream.status }) };
    const server = serversWithRevisions(profile, payload).find((row) => row.name === name);
    if (!server) return { error: Response.json({ detail: "MCP server no longer exists" }, { status: 409 }) };
    const identity: Record<string, unknown> = { ...server };
    delete identity.revision;
    return { server: identity };
  } catch {
    return { error: Response.json({ detail: "Hermes MCP service is unavailable" }, { status: 503 }) };
  }
}
