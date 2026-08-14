import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, readObjectBody } from "@/lib/server/control-input";
import { cronRevision, serializeCronMutation, withCronRevision } from "@/lib/server/cron-revision";

export const dynamic = "force-dynamic";

const updateFields = new Set([
  "schedule", "prompt", "name", "deliver", "skills", "model", "provider",
  "base_url", "context_from", "enabled_toolsets", "workdir",
]);

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { id } = await context.params;
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ detail: "Invalid JSON body" }, { status: 400 });
  const updates = Object.fromEntries(Object.entries(input).filter(([key]) => updateFields.has(key)));
  const expectedRevision = typeof (input as Record<string, unknown>).expected_revision === "string" ? (input as Record<string, unknown>).expected_revision as string : "";
  const profile = typeof (input as Record<string, unknown>).profile === "string" && identifierPattern.test((input as Record<string, unknown>).profile as string)
    ? (input as Record<string, unknown>).profile as string
    : "default";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return Response.json({ detail: "Refresh this cron job before editing it" }, { status: 428 });
  return serializeCronMutation(async () => {
    try {
      const currentResponse = await dashboardRequest(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`);
      const current = await currentResponse.json().catch(() => null);
      if (!currentResponse.ok || !current || typeof current !== "object" || Array.isArray(current)) return Response.json({ detail: "Hermes could not reload this cron job" }, { status: currentResponse.status || 502 });
      if (cronRevision(profile, current as Record<string, unknown>) !== expectedRevision) return Response.json({ detail: "This cron job changed. Refresh before editing." }, { status: 409 });
      const upstream = await dashboardRequest(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: "PUT", body: JSON.stringify({ updates }) });
      const payload = await upstream.json().catch(() => null);
      if (!upstream.ok) return Response.json({ detail: "Hermes could not update this cron job" }, { status: upstream.status });
      const job = withCronRevision(profile, payload);
      return job ? Response.json(job, { headers: { "Cache-Control": "no-store" } }) : Response.json({ detail: "Hermes returned an invalid cron job" }, { status: 502 });
    } catch {
      return Response.json({ detail: "Hermes cron service is unavailable" }, { status: 503 });
    }
  });
}

export async function DELETE(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const { id } = await context.params;
  const profile = new URL(request.url).searchParams.get("profile") || "default";
  if (!identifierPattern.test(profile)) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  const input = await readObjectBody(request);
  const expectedRevision = typeof input?.expected_revision === "string" ? input.expected_revision : "";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return Response.json({ detail: "Refresh this cron job before deleting it" }, { status: 428 });
  return serializeCronMutation(async () => {
    try {
      const currentResponse = await dashboardRequest(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`);
      const current = await currentResponse.json().catch(() => null);
      if (!currentResponse.ok || !current || typeof current !== "object" || Array.isArray(current)) return Response.json({ detail: "Hermes could not reload this cron job" }, { status: currentResponse.status || 502 });
      if (cronRevision(profile, current as Record<string, unknown>) !== expectedRevision) return Response.json({ detail: "This cron job changed. Refresh before deleting." }, { status: 409 });
      const upstream = await dashboardRequest(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" });
      if (!upstream.ok) return Response.json({ detail: "Hermes could not delete this cron job" }, { status: upstream.status });
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ detail: "Hermes cron service is unavailable" }, { status: 503 });
    }
  });
}
