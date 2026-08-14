import { dashboardJsonResponse, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, readObjectBody } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

function validId(id: string) {
  return Boolean(id) && id.length <= 240 && !/[\r\n]/.test(id);
}

export async function PATCH(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { id } = await context.params;
  const input = await readObjectBody(request);
  if (!validId(id) || !input) return Response.json({ detail: "Invalid session update" }, { status: 400 });
  const body: Record<string, unknown> = {};
  if (typeof input.title === "string" && input.title.length <= 240) body.title = input.title;
  if (typeof input.archived === "boolean") body.archived = input.archived;
  if (typeof input.pinned === "boolean") body.pinned = input.pinned;
  if (typeof input.profile === "string" && identifierPattern.test(input.profile)) body.profile = input.profile;
  if (!Object.keys(body).length) return Response.json({ detail: "No supported session fields" }, { status: 422 });
  return dashboardJsonResponse(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function DELETE(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ detail: "Invalid session id" }, { status: 400 });
  const profile = new URL(request.url).searchParams.get("profile") || "default";
  if (!identifierPattern.test(profile)) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  return dashboardJsonResponse(`/api/sessions/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" });
}
