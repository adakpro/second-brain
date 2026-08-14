import { dashboardJsonResponse, dashboardRequest } from "@/lib/server/hermes-dashboard";
import { profileFromRequest } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";

type ArchiveMode = "exclude" | "include" | "only";
type JsonObject = Record<string, unknown>;

function proxiedResponse(body: string, status: number, contentType: string | null) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function filteredSearchResponse(path: string, archiveMode: ArchiveMode, limit: number) {
  try {
    const upstream = await dashboardRequest(path);
    const body = await upstream.text();
    if (!upstream.ok) return proxiedResponse(body, upstream.status, upstream.headers.get("content-type"));

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      return Response.json({ detail: "Hermes returned an invalid sessions search response" }, { status: 502 });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray((payload as JsonObject).results)) {
      return Response.json({ detail: "Hermes returned an invalid sessions search response" }, { status: 502 });
    }

    const record = payload as JsonObject;
    const filtered = (record.results as unknown[]).filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      if (archiveMode === "include") return true;
      const archived = (item as JsonObject).archived;
      return archiveMode === "only" ? archived === true : archived === false;
    }).slice(0, limit);

    return Response.json({ ...record, results: filtered }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return Response.json(
      { detail: cause instanceof Error ? cause.message : "Hermes dashboard is unavailable" },
      { status: 503 },
    );
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const profile = profileFromRequest(request);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });
  const query = params.get("q")?.trim().slice(0, 500);
  const source = params.get("source")?.trim().slice(0, 120);
  const archived = params.get("archived");
  const archiveMode: ArchiveMode = archived === "include" || archived === "only" ? archived : "exclude";
  const rawLimit = Number(params.get("limit") || 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
  const sourceParam = source ? `&source=${encodeURIComponent(source)}` : "";
  if (query) {
    // Hermes search always includes archived rows. Over-fetch up to the upstream
    // cap before applying the requested archive policy so filtering does not
    // silently consume most of the caller's result window.
    const searchLimit = archiveMode === "include" ? limit : 100;
    const path = `/api/sessions/search?q=${encodeURIComponent(query)}&limit=${searchLimit}&profile=${encodeURIComponent(profile)}${sourceParam}`;
    return filteredSearchResponse(path, archiveMode, limit);
  }
  return dashboardJsonResponse(`/api/sessions?limit=${limit}&offset=0&min_messages=0&archived=${archiveMode}&order=recent&profile=${encodeURIComponent(profile)}${sourceParam}`);
}
