import { dashboardJsonResponse, dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { cleanText, identifierPattern, profileFromRequest, readObjectBody } from "@/lib/server/control-input";
import { serversWithRevisions } from "@/lib/server/mcp-revision";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const profile = profileFromRequest(request);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  try {
    const upstream = await dashboardRequest(`/api/mcp/servers?profile=${encodeURIComponent(profile)}`);
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) return Response.json({ detail: "Hermes could not list MCP servers" }, { status: upstream.status });
    return Response.json({ servers: serversWithRevisions(profile, payload) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes MCP service is unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const input = await readObjectBody(request);
  const name = cleanText(input?.name, 120);
  const rawUrl = cleanText(input?.url, 2048);
  if (!name || !rawUrl) return Response.json({ detail: "A name and HTTPS URL are required" }, { status: 422 });
  let url: URL;
  try { url = new URL(rawUrl); } catch { return Response.json({ detail: "Invalid MCP URL" }, { status: 422 }); }
  if (url.protocol !== "https:") return Response.json({ detail: "Remote MCP servers must use HTTPS" }, { status: 422 });
  const auth = input?.auth === "header" ? "header" : input?.auth === "oauth" ? "oauth" : "none";
  const bearerToken = typeof input?.bearer_token === "string" && input.bearer_token.length <= 10_000
    ? input.bearer_token
    : undefined;
  if (auth === "header" && !bearerToken) return Response.json({ detail: "A bearer token is required for header authentication" }, { status: 422 });
  const profile = typeof input?.profile === "string" && identifierPattern.test(input.profile) ? input.profile : "default";
  return dashboardJsonResponse("/api/mcp/servers", {
    method: "POST",
    body: JSON.stringify({ name, url: url.toString(), auth, bearer_token: bearerToken, profile }),
  });
}
