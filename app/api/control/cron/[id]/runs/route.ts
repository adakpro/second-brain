import { dashboardJsonResponse } from "@/lib/server/hermes-dashboard";
import { identifierPattern } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") || 20);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 20;
  const profile = new URL(request.url).searchParams.get("profile") || "default";
  if (!id || id.length > 240 || /[\r\n]/.test(id)) return Response.json({ detail: "Invalid cron job id" }, { status: 400 });
  if (!identifierPattern.test(profile)) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  return dashboardJsonResponse(`/api/cron/jobs/${encodeURIComponent(id)}/runs?profile=${encodeURIComponent(profile)}&limit=${limit}`);
}
