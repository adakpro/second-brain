import { dashboardRequest } from "@/lib/server/hermes-dashboard";
import { profileFromRequest } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const profile = profileFromRequest(request);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  try {
    const [statusResponse, graphResponse] = await Promise.all([
      dashboardRequest("/api/memory"),
      dashboardRequest(`/api/learning/graph?profile=${encodeURIComponent(profile)}`),
    ]);
    if (!statusResponse.ok || !graphResponse.ok) {
      return Response.json({ detail: "Hermes memory is unavailable" }, { status: Math.max(statusResponse.status, graphResponse.status) });
    }
    const [status, graph] = await Promise.all([statusResponse.json(), graphResponse.json()]);
    return Response.json({ status, graph }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes memory is unavailable" }, { status: 503 });
  }
}
