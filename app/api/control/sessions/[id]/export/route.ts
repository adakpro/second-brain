import { dashboardRequest } from "@/lib/server/hermes-dashboard";
import { profileFromRequest } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const profile = profileFromRequest(request);
  if (!id || id.length > 240 || /[\r\n]/.test(id) || !profile) return Response.json({ detail: "Invalid session reference" }, { status: 400 });
  try {
    const upstream = await dashboardRequest(`/api/sessions/${encodeURIComponent(id)}/export?profile=${encodeURIComponent(profile)}`);
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Content-Disposition": upstream.headers.get("content-disposition") ?? `attachment; filename="session-${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ detail: "Hermes session export is unavailable" }, { status: 503 });
  }
}
