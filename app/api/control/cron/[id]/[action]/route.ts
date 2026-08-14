import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, readObjectBody } from "@/lib/server/control-input";
import { cronRevision, serializeCronMutation, withCronRevision } from "@/lib/server/cron-revision";

export const dynamic = "force-dynamic";

const allowedActions = new Set(["pause", "resume", "trigger"]);
type Context = { params: Promise<{ id: string; action: string }> };

export async function POST(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { id, action } = await context.params;
  if (!allowedActions.has(action)) return Response.json({ detail: "Unsupported cron action" }, { status: 404 });
  const profile = new URL(request.url).searchParams.get("profile") || "default";
  if (!identifierPattern.test(profile)) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  const input = await readObjectBody(request);
  const expectedRevision = typeof input?.expected_revision === "string" ? input.expected_revision : "";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return Response.json({ detail: "Refresh this cron job before acting on it" }, { status: 428 });
  return serializeCronMutation(async () => {
    try {
      const currentResponse = await dashboardRequest(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`);
      const current = await currentResponse.json().catch(() => null);
      if (!currentResponse.ok || !current || typeof current !== "object" || Array.isArray(current)) {
        return Response.json({ detail: "Hermes could not reload this cron job" }, { status: currentResponse.status || 502 });
      }
      if (cronRevision(profile, current as Record<string, unknown>) !== expectedRevision) {
        return Response.json({ detail: "This cron job changed. Refresh before acting on it." }, { status: 409 });
      }
      const upstream = await dashboardRequest(`/api/cron/jobs/${encodeURIComponent(id)}/${action}?profile=${encodeURIComponent(profile)}`, { method: "POST" });
      const payload = await upstream.json().catch(() => null);
      if (!upstream.ok) return Response.json({ detail: `Hermes could not ${action} this cron job` }, { status: upstream.status });
      const job = withCronRevision(profile, payload);
      return job ? Response.json(job, { headers: { "Cache-Control": "no-store" } }) : Response.json({ detail: "Hermes returned an invalid cron job" }, { status: 502 });
    } catch {
      return Response.json({ detail: "Hermes cron service is unavailable" }, { status: 503 });
    }
  });
}
