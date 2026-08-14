import { dashboardJsonResponse, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, readObjectBody } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ name: string }> };

export async function POST(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { name } = await context.params;
  const input = await readObjectBody(request) ?? {};
  const profile = typeof input.profile === "string" && identifierPattern.test(input.profile) ? input.profile : "default";
  if (!identifierPattern.test(name)) return Response.json({ detail: "Invalid server name" }, { status: 400 });
  return dashboardJsonResponse(`/api/mcp/servers/${encodeURIComponent(name)}/test?profile=${encodeURIComponent(profile)}`, { method: "POST" });
}
