import { identifierPattern } from "@/lib/server/control-input";

type StrictQueryResult =
  | { params: URLSearchParams; error?: never }
  | { params?: never; error: Response };

function queryError(detail: string) {
  return Response.json(
    { detail },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export function strictQuery(request: Request, allowedKeys: readonly string[]): StrictQueryResult {
  const params = new URL(request.url).searchParams;
  const allowed = new Set(allowedKeys);

  for (const key of params.keys()) {
    if (!allowed.has(key)) return { error: queryError(`Unsupported query parameter: ${key}`) };
  }
  for (const key of allowed) {
    if (params.getAll(key).length > 1) return { error: queryError(`Duplicate query parameter: ${key}`) };
  }
  return { params };
}

export function profileFromParams(params: URLSearchParams) {
  const profile = params.get("profile")?.trim() || "default";
  return identifierPattern.test(profile) ? profile : null;
}

export function analyticsParams(request: Request) {
  const query = strictQuery(request, ["days", "profile"]);
  if (query.error) return { error: query.error } as const;

  const rawDays = query.params.get("days") ?? "30";
  if (rawDays !== "7" && rawDays !== "30" && rawDays !== "90") {
    return { error: queryError("days must be one of 7, 30, or 90") } as const;
  }
  const profile = profileFromParams(query.params);
  if (!profile) return { error: queryError("Invalid profile") } as const;

  return { days: rawDays, profile } as const;
}
