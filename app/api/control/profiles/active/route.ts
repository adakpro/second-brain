import { dashboardJsonResponse, dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, readObjectBody } from "@/lib/server/control-input";
import { profileConfigRevision, serializeProfileMutation } from "@/lib/server/profile-revision";

export const dynamic = "force-dynamic";

export async function GET() {
  return dashboardJsonResponse("/api/profiles/active");
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const input = await readObjectBody(request);
  const name = typeof input?.name === "string" ? input.name : "";
  if (!identifierPattern.test(name)) return Response.json({ detail: "Invalid profile name" }, { status: 422 });
  const expectedRevision = typeof input?.expected_revision === "string" ? input.expected_revision : "";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return Response.json({ detail: "Refresh this profile before activating it" }, { status: 428 });
  return serializeProfileMutation(async () => {
    try {
      const currentResponse = await dashboardRequest(`/api/config/raw?profile=${encodeURIComponent(name)}`);
      const current = await currentResponse.json().catch(() => null);
      if (!currentResponse.ok || !current || typeof current !== "object" || Array.isArray(current)) {
        return Response.json({ detail: "Hermes could not reload this profile" }, { status: currentResponse.status || 502 });
      }
      const currentYaml = (current as Record<string, unknown>).yaml;
      if (typeof currentYaml !== "string") return Response.json({ detail: "Hermes returned an invalid profile config" }, { status: 502 });
      if (profileConfigRevision(name, currentYaml) !== expectedRevision) {
        return Response.json({ detail: "This profile changed. Refresh before activating it." }, { status: 409 });
      }
      return dashboardJsonResponse("/api/profiles/active", { method: "POST", body: JSON.stringify({ name }) });
    } catch {
      return Response.json({ detail: "Hermes profile service is unavailable" }, { status: 503 });
    }
  });
}
