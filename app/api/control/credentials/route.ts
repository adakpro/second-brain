import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { cleanText, identifierPattern, readObjectBody } from "@/lib/server/control-input";
import { sanitizeCredentialPool } from "@/lib/server/credential-revision";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const upstream = await dashboardRequest("/api/credentials/pool");
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) return Response.json({ detail: "Hermes credential pool is unavailable" }, { status: upstream.status });
    return Response.json({ providers: sanitizeCredentialPool(payload) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes credential service is unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const input = await readObjectBody(request);
  const provider = cleanText(input?.provider, 120);
  const label = typeof input?.label === "string" ? input.label.trim().slice(0, 120) : undefined;
  const apiKey = typeof input?.api_key === "string" ? input.api_key.trim() : "";
  if (!provider || !identifierPattern.test(provider) || !apiKey || apiKey.length > 10_000) {
    return Response.json({ detail: "A valid provider and API key are required" }, { status: 422 });
  }
  try {
    const upstream = await dashboardRequest("/api/credentials/pool", {
      method: "POST",
      body: JSON.stringify({ provider, api_key: apiKey, ...(label ? { label } : {}) }),
    });
    if (!upstream.ok) return Response.json({ detail: "Hermes rejected the credential" }, { status: upstream.status });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes credential service is unavailable" }, { status: 503 });
  }
}
