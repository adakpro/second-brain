import { dashboardJsonResponse, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { cleanText, identifierPattern, profileFromRequest, readObjectBody } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const profile = profileFromRequest(request);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  return dashboardJsonResponse(`/api/skills?profile=${encodeURIComponent(profile)}`);
}

export async function PATCH(request: Request) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const input = await readObjectBody(request);
  const name = cleanText(input?.name, 160);
  const profile = typeof input?.profile === "string" && identifierPattern.test(input.profile) ? input.profile : "default";
  if (!name || typeof input?.enabled !== "boolean") {
    return Response.json({ detail: "A skill name and enabled state are required" }, { status: 422 });
  }
  return dashboardJsonResponse(`/api/skills/toggle?profile=${encodeURIComponent(profile)}`, {
    method: "PUT",
    body: JSON.stringify({ name, enabled: input.enabled, profile }),
  });
}
