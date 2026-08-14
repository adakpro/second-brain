import { dashboardJsonResponse } from "@/lib/server/hermes-dashboard";
import { profileFromParams, strictQuery } from "@/lib/server/control-query";

export const dynamic = "force-dynamic";

const logFiles = new Set(["agent", "errors", "gateway", "gui", "desktop", "mcp"]);
const logLevels = new Set(["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
const logComponents = new Set(["all", "gateway", "agent", "tools", "cli", "cron", "gui"]);

export async function GET(request: Request) {
  const query = strictQuery(request, ["profile", "file", "lines", "level", "component", "search"]);
  if (query.error) return query.error;
  if (!profileFromParams(query.params)) {
    return Response.json({ detail: "Invalid profile" }, { status: 400 });
  }

  const file = query.params.get("file") ?? "agent";
  if (!logFiles.has(file)) {
    return Response.json({ detail: "Invalid log file" }, { status: 400 });
  }

  const rawLines = query.params.get("lines") ?? "100";
  if (!/^[1-9]\d{0,2}$/.test(rawLines) || Number(rawLines) > 500) {
    return Response.json({ detail: "lines must be an integer from 1 to 500" }, { status: 400 });
  }

  const level = (query.params.get("level") ?? "ALL").toUpperCase();
  if (!logLevels.has(level)) {
    return Response.json({ detail: "Invalid log level" }, { status: 400 });
  }

  const component = (query.params.get("component") ?? "all").toLowerCase();
  if (!logComponents.has(component)) {
    return Response.json({ detail: "Invalid log component" }, { status: 400 });
  }

  const search = query.params.get("search")?.trim() ?? "";
  const hasControlCharacter = [...search].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (search.length > 160 || hasControlCharacter) {
    return Response.json({ detail: "search must be at most 160 printable characters" }, { status: 400 });
  }

  const upstream = new URLSearchParams({ file, lines: rawLines });
  if (level !== "ALL") upstream.set("level", level);
  if (component !== "all") upstream.set("component", component);
  if (search) upstream.set("search", search);
  return dashboardJsonResponse(`/api/logs?${upstream.toString()}`);
}
