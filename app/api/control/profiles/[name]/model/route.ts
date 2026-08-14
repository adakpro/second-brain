import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { profileConfigRevision, serializeProfileMutation } from "@/lib/server/profile-revision";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ name: string }> };

const profileName = /^[a-zA-Z0-9_-]{1,80}$/;
const providerName = /^[a-zA-Z0-9_.-]{1,120}$/;

export async function PUT(request: Request, context: Context) {
  if (!sameOriginMutation(request)) {
    return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  }

  const { name } = await context.params;
  if (!profileName.test(name)) {
    return Response.json({ detail: "Invalid profile name" }, { status: 400 });
  }

  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const provider = typeof input?.provider === "string" ? input.provider.trim() : "";
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  const expectedRevision = typeof input?.expected_revision === "string" ? input.expected_revision : "";
  if (!providerName.test(provider) || !model || model.length > 240 || /[\r\n]/.test(model)) {
    return Response.json({ detail: "A valid provider and model are required" }, { status: 422 });
  }
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    return Response.json({ detail: "Refresh this profile before editing it" }, { status: 428 });
  }

  return serializeProfileMutation(async () => {
    try {
      const rawConfigPath = `/api/config/raw?profile=${encodeURIComponent(name)}`;
      const currentResponse = await dashboardRequest(rawConfigPath);
      const current = await currentResponse.json().catch(() => null);
      if (!currentResponse.ok || !current || typeof current !== "object" || Array.isArray(current)) {
        return Response.json({ detail: "Hermes could not reload this profile" }, { status: currentResponse.status || 502 });
      }
      const currentYaml = (current as Record<string, unknown>).yaml;
      if (typeof currentYaml !== "string") return Response.json({ detail: "Hermes returned an invalid profile config" }, { status: 502 });
      if (profileConfigRevision(name, currentYaml) !== expectedRevision) {
        return Response.json({ detail: "This profile changed. Refresh before editing it." }, { status: 409 });
      }

      // Use Hermes' canonical assignment helper so switching providers clears
      // stale base URLs, credentials, API mode, and context overrides.
      const updateResponse = await dashboardRequest(`/api/profiles/${encodeURIComponent(name)}/model`, {
        method: "PUT",
        body: JSON.stringify({ provider, model }),
      });
      const updatePayload = await updateResponse.json().catch(() => null);
      if (!updateResponse.ok) {
        return Response.json({ detail: "Hermes could not update this profile" }, { status: updateResponse.status });
      }
      const refreshedResponse = await dashboardRequest(rawConfigPath);
      const refreshed = await refreshedResponse.json().catch(() => null);
      if (!refreshedResponse.ok || !refreshed || typeof refreshed !== "object" || Array.isArray(refreshed)) {
        return Response.json({ detail: "Profile saved, but Hermes could not verify the result" }, { status: 502 });
      }
      const refreshedYaml = (refreshed as Record<string, unknown>).yaml;
      if (typeof refreshedYaml !== "string") return Response.json({ detail: "Profile saved, but Hermes returned invalid config" }, { status: 502 });
      const result = updatePayload && typeof updatePayload === "object" && !Array.isArray(updatePayload)
        ? updatePayload as Record<string, unknown>
        : {};
      return Response.json({
        ok: true,
        provider: String(result.provider ?? provider),
        model: String(result.model ?? model),
        _revision: profileConfigRevision(name, refreshedYaml),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ detail: "Hermes profile service is unavailable" }, { status: 503 });
    }
  });
}
