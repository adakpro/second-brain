import { dashboardJsonResponse } from "@/lib/server/hermes-dashboard";
import { profileFromRequest } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  if (!id || id.length > 240 || /[\r\n]/.test(id)) {
    return Response.json({ detail: "Invalid session id" }, { status: 400 });
  }
  const profile = profileFromRequest(request);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  return dashboardJsonResponse(`/api/sessions/${encodeURIComponent(id)}/messages?profile=${encodeURIComponent(profile)}&limit=500&offset=0`);
}
