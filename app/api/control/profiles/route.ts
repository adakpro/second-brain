import { dashboardRequest } from "@/lib/server/hermes-dashboard";
import { identifierPattern } from "@/lib/server/control-input";
import { profileConfigRevision } from "@/lib/server/profile-revision";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const upstream = await dashboardRequest("/api/profiles");
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ detail: "Hermes could not list profiles" }, { status: upstream.status || 502 });
    }
    const record = payload as Record<string, unknown>;
    const profiles = Array.isArray(record.profiles) ? record.profiles : [];
    const enriched = await Promise.all(profiles.map(async (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const row = value as Record<string, unknown>;
      const name = typeof row.name === "string" && identifierPattern.test(row.name) ? row.name : "";
      if (!name) return row;
      try {
        const configResponse = await dashboardRequest(`/api/config/raw?profile=${encodeURIComponent(name)}`);
        const config = await configResponse.json().catch(() => null);
        const yaml = config && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, unknown>).yaml
          : null;
        return configResponse.ok && typeof yaml === "string"
          ? { ...row, _revision: profileConfigRevision(name, yaml) }
          : row;
      } catch {
        return row;
      }
    }));
    return Response.json({ ...record, profiles: enriched }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes profile service is unavailable" }, { status: 503 });
  }
}
