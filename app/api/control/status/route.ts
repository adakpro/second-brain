import { dashboardJsonResponse } from "@/lib/server/hermes-dashboard";
import { profileFromParams, strictQuery } from "@/lib/server/control-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = strictQuery(request, ["profile"]);
  if (query.error) return query.error;
  const profile = profileFromParams(query.params);
  if (!profile) return Response.json({ detail: "Invalid profile" }, { status: 400 });

  // Gateway/process health belongs to the running Hermes service, not to a
  // multiplexed profile. Named-profile status can report "stopped" even while
  // the shared gateway is healthy, so the operations view uses global status.
  return dashboardJsonResponse("/api/status");
}
