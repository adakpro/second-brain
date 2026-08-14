import { dashboardJsonResponse } from "@/lib/server/hermes-dashboard";
import { cleanText, profileFromRequest } from "@/lib/server/control-input";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const profile = profileFromRequest(request);
  const name = cleanText(url.searchParams.get("name"), 160);
  if (!profile || !name) return Response.json({ detail: "A valid skill name and profile are required" }, { status: 400 });
  return dashboardJsonResponse(`/api/skills/content?name=${encodeURIComponent(name)}&profile=${encodeURIComponent(profile)}`);
}
