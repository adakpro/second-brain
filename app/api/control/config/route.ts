import { identifierPattern } from "@/lib/server/control-input";
import { profileFromParams, strictQuery } from "@/lib/server/control-query";
import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

const serviceTiers = new Set(["", "auto", "default", "flex", "priority"]);
const reasoningEfforts = new Set(["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const streamingTransports = new Set(["auto", "draft", "edit", "off"]);
const loggingLevels = new Set(["DEBUG", "INFO", "WARNING", "ERROR"]);
let mutationQueue: Promise<void> = Promise.resolve();

type JsonObject = Record<string, unknown>;

type SafeConfigValues = {
  max_live_sessions: number;
  max_turns: number;
  gateway_timeout: number;
  service_tier: string;
  reasoning_effort: string;
  compression_enabled: boolean;
  compression_threshold: number;
  streaming_enabled: boolean;
  streaming_transport: string;
  sessions_auto_prune: boolean;
  sessions_retention_days: number;
  logging_level: string;
};

type SafeConfigPatch = Partial<SafeConfigValues>;

const defaultValues: SafeConfigValues = {
  max_live_sessions: 16,
  max_turns: 500,
  gateway_timeout: 1800,
  service_tier: "",
  reasoning_effort: "",
  compression_enabled: true,
  compression_threshold: 0.5,
  streaming_enabled: false,
  streaming_transport: "auto",
  sessions_auto_prune: false,
  sessions_retention_days: 90,
  logging_level: "INFO",
};

const valueKeys = new Set<keyof SafeConfigValues>([
  "max_live_sessions",
  "max_turns",
  "gateway_timeout",
  "service_tier",
  "reasoning_effort",
  "compression_enabled",
  "compression_threshold",
  "streaming_enabled",
  "streaming_transport",
  "sessions_auto_prune",
  "sessions_retention_days",
  "logging_level",
]);

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordAt(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  return isObject(value) ? value : {};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function allowedString(value: unknown, fallback: string, allowed: Set<string>) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function configValues(config: JsonObject): SafeConfigValues {
  const agent = recordAt(config, "agent");
  const compression = recordAt(config, "compression");
  const streaming = recordAt(config, "streaming");
  const sessions = recordAt(config, "sessions");
  const logging = recordAt(config, "logging");

  return {
    max_live_sessions: config.max_live_sessions === null
      ? 0
      : boundedInteger(config.max_live_sessions, defaultValues.max_live_sessions, 0, 1024),
    max_turns: boundedInteger(agent.max_turns, defaultValues.max_turns, 1, 10_000),
    gateway_timeout: boundedInteger(agent.gateway_timeout, defaultValues.gateway_timeout, 0, 86_400),
    service_tier: allowedString(agent.service_tier, defaultValues.service_tier, serviceTiers),
    reasoning_effort: allowedString(agent.reasoning_effort, defaultValues.reasoning_effort, reasoningEfforts),
    compression_enabled: typeof compression.enabled === "boolean"
      ? compression.enabled
      : defaultValues.compression_enabled,
    compression_threshold: boundedNumber(
      compression.threshold,
      defaultValues.compression_threshold,
      0.1,
      1,
    ),
    streaming_enabled: typeof streaming.enabled === "boolean"
      ? streaming.enabled
      : defaultValues.streaming_enabled,
    streaming_transport: allowedString(
      streaming.transport,
      defaultValues.streaming_transport,
      streamingTransports,
    ),
    sessions_auto_prune: typeof sessions.auto_prune === "boolean"
      ? sessions.auto_prune
      : defaultValues.sessions_auto_prune,
    sessions_retention_days: boundedInteger(
      sessions.retention_days,
      defaultValues.sessions_retention_days,
      1,
      3650,
    ),
    logging_level: allowedString(logging.level, defaultValues.logging_level, loggingLevels),
  };
}

function integerInput(value: unknown, name: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    return { error: `${name} must be an integer from ${minimum} to ${maximum}` } as const;
  }
  return { value } as const;
}

function numberInput(value: unknown, name: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return { error: `${name} must be a number from ${minimum} to ${maximum}` } as const;
  }
  return { value } as const;
}

function booleanInput(value: unknown, name: string) {
  if (typeof value !== "boolean") return { error: `${name} must be a boolean` } as const;
  return { value } as const;
}

function enumInput(value: unknown, name: string, allowed: Set<string>) {
  if (typeof value !== "string" || !allowed.has(value)) return { error: `${name} is not supported` } as const;
  return { value } as const;
}

function parseValues(input: JsonObject): { value: SafeConfigPatch; error?: never } | { value?: never; error: string } {
  for (const key of Object.keys(input)) {
    if (!valueKeys.has(key as keyof SafeConfigValues)) return { error: `Unsupported config field: ${key}` };
  }
  if (Object.keys(input).length === 0) return { error: "values must contain at least one config field" };

  const output: SafeConfigPatch = {};
  for (const [key, raw] of Object.entries(input)) {
    switch (key as keyof SafeConfigValues) {
      case "max_live_sessions": {
        const parsed = integerInput(raw, key, 0, 1024);
        if (parsed.error) return parsed;
        output.max_live_sessions = parsed.value;
        break;
      }
      case "max_turns": {
        const parsed = integerInput(raw, key, 1, 10_000);
        if (parsed.error) return parsed;
        output.max_turns = parsed.value;
        break;
      }
      case "gateway_timeout": {
        const parsed = integerInput(raw, key, 0, 86_400);
        if (parsed.error) return parsed;
        output.gateway_timeout = parsed.value;
        break;
      }
      case "service_tier": {
        const parsed = enumInput(raw, key, serviceTiers);
        if (parsed.error) return parsed;
        output.service_tier = parsed.value;
        break;
      }
      case "reasoning_effort": {
        const parsed = enumInput(raw, key, reasoningEfforts);
        if (parsed.error) return parsed;
        output.reasoning_effort = parsed.value;
        break;
      }
      case "compression_enabled": {
        const parsed = booleanInput(raw, key);
        if (parsed.error) return parsed;
        output.compression_enabled = parsed.value;
        break;
      }
      case "compression_threshold": {
        const parsed = numberInput(raw, key, 0.1, 1);
        if (parsed.error) return parsed;
        output.compression_threshold = parsed.value;
        break;
      }
      case "streaming_enabled": {
        const parsed = booleanInput(raw, key);
        if (parsed.error) return parsed;
        output.streaming_enabled = parsed.value;
        break;
      }
      case "streaming_transport": {
        const parsed = enumInput(raw, key, streamingTransports);
        if (parsed.error) return parsed;
        output.streaming_transport = parsed.value;
        break;
      }
      case "sessions_auto_prune": {
        if (raw !== false) return { error: "sessions_auto_prune can only be disabled; use verified manual pruning" };
        output.sessions_auto_prune = false;
        break;
      }
      case "sessions_retention_days": {
        const parsed = integerInput(raw, key, 1, 3650);
        if (parsed.error) return parsed;
        output.sessions_retention_days = parsed.value;
        break;
      }
      case "logging_level": {
        const parsed = enumInput(raw, key, loggingLevels);
        if (parsed.error) return parsed;
        output.logging_level = parsed.value;
        break;
      }
    }
  }
  return { value: output };
}

function nestedConfig(values: SafeConfigPatch) {
  const config: JsonObject = {};
  if (values.max_live_sessions !== undefined) config.max_live_sessions = values.max_live_sessions;

  const agent: JsonObject = {};
  if (values.max_turns !== undefined) agent.max_turns = values.max_turns;
  if (values.gateway_timeout !== undefined) agent.gateway_timeout = values.gateway_timeout;
  if (values.service_tier !== undefined) agent.service_tier = values.service_tier;
  if (values.reasoning_effort !== undefined) agent.reasoning_effort = values.reasoning_effort;
  if (Object.keys(agent).length) config.agent = agent;

  const compression: JsonObject = {};
  if (values.compression_enabled !== undefined) compression.enabled = values.compression_enabled;
  if (values.compression_threshold !== undefined) compression.threshold = values.compression_threshold;
  if (Object.keys(compression).length) config.compression = compression;

  const streaming: JsonObject = {};
  if (values.streaming_enabled !== undefined) streaming.enabled = values.streaming_enabled;
  if (values.streaming_transport !== undefined) streaming.transport = values.streaming_transport;
  if (Object.keys(streaming).length) config.streaming = streaming;

  const sessions: JsonObject = {};
  if (values.sessions_auto_prune !== undefined) sessions.auto_prune = false;
  if (values.sessions_retention_days !== undefined) sessions.retention_days = values.sessions_retention_days;
  if (Object.keys(sessions).length) config.sessions = sessions;

  if (values.logging_level !== undefined) config.logging = { level: values.logging_level };
  return config;
}

async function loadConfig(profile: string) {
  try {
    const upstream = await dashboardRequest(`/api/config?profile=${encodeURIComponent(profile)}`);
    if (!upstream.ok) {
      return { error: json({ detail: "Hermes rejected the configuration request" }, upstream.status) } as const;
    }
    const body = await upstream.json().catch(() => null);
    if (!isObject(body)) return { error: json({ detail: "Hermes returned an invalid configuration" }, 502) } as const;
    return { values: configValues(body) } as const;
  } catch {
    return { error: json({ detail: "Hermes dashboard is unavailable" }, 503) } as const;
  }
}

function configRevision(profile: string, values: SafeConfigValues) {
  return createHash("sha256").update(profile).update("\0").update(JSON.stringify(values)).digest("hex");
}

function serialize<T>(operation: () => Promise<T>) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { error: json({ detail: "Request body is too large" }, 413) } as const;
  }
  const text = await request.text().catch(() => "");
  if (!text || new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { error: json({ detail: text ? "Request body is too large" : "Invalid JSON body" }, text ? 413 : 400) } as const;
  }
  const parsed = (() => {
    try { return JSON.parse(text) as unknown; } catch { return null; }
  })();
  if (!isObject(parsed)) return { error: json({ detail: "Invalid JSON body" }, 400) } as const;
  return { value: parsed } as const;
}

export async function GET(request: Request) {
  const query = strictQuery(request, ["profile"]);
  if (query.error) return query.error;
  const profile = profileFromParams(query.params);
  if (!profile) return json({ detail: "Invalid profile" }, 400);

  const current = await loadConfig(profile);
  if (current.error) return current.error;
  return json({ profile, values: current.values, revision: configRevision(profile, current.values) });
}

export async function PUT(request: Request) {
  if (!sameOriginMutation(request)) return json({ detail: "Same-origin request required" }, 403);

  const query = strictQuery(request, ["profile"]);
  if (query.error) return query.error;
  const queryProfile = profileFromParams(query.params);
  if (!queryProfile) return json({ detail: "Invalid profile" }, 400);

  const body = await readBody(request);
  if (body.error) return body.error;
  for (const key of Object.keys(body.value)) {
    if (key !== "profile" && key !== "values" && key !== "expected_revision") return json({ detail: `Unsupported request field: ${key}` }, 422);
  }
  const expectedRevision = typeof body.value.expected_revision === "string" ? body.value.expected_revision : "";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) return json({ detail: "Refresh the live configuration before saving" }, 428);

  let profile = queryProfile;
  if (body.value.profile !== undefined) {
    if (typeof body.value.profile !== "string") return json({ detail: "Invalid profile" }, 422);
    const bodyProfile = body.value.profile.trim() || "default";
    if (!identifierPattern.test(bodyProfile)) return json({ detail: "Invalid profile" }, 422);
    if (query.params.has("profile") && bodyProfile !== queryProfile) {
      return json({ detail: "Profile does not match the request URL" }, 422);
    }
    profile = bodyProfile;
  }

  if (!isObject(body.value.values)) return json({ detail: "values must be an object" }, 422);
  const parsed = parseValues(body.value.values);
  if ("error" in parsed) return json({ detail: parsed.error }, 422);

  return serialize(async () => {
    const current = await loadConfig(profile);
    if (current.error) return current.error;
    if (configRevision(profile, current.values) !== expectedRevision) {
      return json({ detail: "This profile configuration changed. Reload before saving." }, 409);
    }

    try {
      const upstream = await dashboardRequest(`/api/config?profile=${encodeURIComponent(profile)}`, {
        method: "PUT",
        body: JSON.stringify({ config: nestedConfig(parsed.value) }),
      });
      if (!upstream.ok) {
        return json({ detail: "Hermes rejected the configuration update" }, upstream.status);
      }
    } catch {
      return json({ detail: "Hermes dashboard is unavailable" }, 503);
    }

    const values = { ...current.values, ...parsed.value };
    return json({ profile, values, revision: configRevision(profile, values) });
  });
}
