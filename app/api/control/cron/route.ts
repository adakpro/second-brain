import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, profileFromRequest } from "@/lib/server/control-input";
import { withCronRevision } from "@/lib/server/cron-revision";

export const dynamic = "force-dynamic";

const createFields = new Set([
  "schedule", "prompt", "name", "deliver", "skills", "model", "provider",
  "base_url", "context_from", "enabled_toolsets", "workdir",
]);

export async function GET(request: Request) {
  const profile = profileFromRequest(request);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  try {
    const upstream = await dashboardRequest(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`);
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) return Response.json({ detail: "Hermes could not list cron jobs" }, { status: upstream.status });
    const jobs = Array.isArray(payload) ? payload.map((job) => withCronRevision(profile, job)).filter(Boolean) : [];
    return Response.json(jobs, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes cron service is unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ detail: "Invalid JSON body" }, { status: 400 });
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => createFields.has(key)));
  if (typeof body.schedule !== "string" || typeof body.prompt !== "string") return Response.json({ detail: "schedule and prompt are required" }, { status: 422 });
  const profile = typeof (input as Record<string, unknown>).profile === "string" && identifierPattern.test((input as Record<string, unknown>).profile as string)
    ? (input as Record<string, unknown>).profile as string
    : "default";
  try {
    const upstream = await dashboardRequest(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`, { method: "POST", body: JSON.stringify(body) });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) return Response.json({ detail: "Hermes could not create the cron job" }, { status: upstream.status });
    const job = withCronRevision(profile, payload);
    if (!job) return Response.json({ detail: "Hermes returned an invalid cron job" }, { status: 502 });
    return Response.json(job, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes cron service is unavailable" }, { status: 503 });
  }
}
