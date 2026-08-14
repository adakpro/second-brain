import { dashboardJsonResponse } from "@/lib/server/hermes-dashboard";
import { analyticsParams } from "@/lib/server/control-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = analyticsParams(request);
  if (query.error) return query.error;
  return dashboardJsonResponse(
    `/api/analytics/usage?days=${query.days}&profile=${encodeURIComponent(query.profile)}`,
  );
}
