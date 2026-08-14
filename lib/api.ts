import type {
  Automation,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  KnowledgeGraph,
  KnowledgeItem,
  KnowledgeVault,
  Profile,
  Session,
  SessionTraceEntry,
  ServiceState,
  SystemSnapshot,
  ToolTrace,
} from "./types";

const HERMES_BASE = "/api/hermes";
const KNOWLEDGE_BASE = "/api/knowledge";

type JsonObject = Record<string, unknown>;

async function requestJson(url: string, init?: RequestInit, timeout = 5_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: init?.signal ?? controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `${response.status} ${response.statusText}`);
    }
    return (await response.json()) as unknown;
  } finally {
    window.clearTimeout(timer);
  }
}

async function probe(url: string): Promise<ServiceState> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(3_500),
    });
    return response.ok ? "online" : response.status < 500 ? "degraded" : "offline";
  } catch {
    return "offline";
  }
}

function numberFrom(source: JsonObject, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

export async function loadSystemSnapshot(profile = "default"): Promise<SystemSnapshot> {
  const [hermes, knowledge] = await Promise.all([
    probe(`${HERMES_BASE}/health`),
    probe(`${KNOWLEDGE_BASE}/health`),
  ]);

  let stats: JsonObject = {};
  if (knowledge === "online") {
    try {
      const payload = await requestJson(`${KNOWLEDGE_BASE}/stats`);
      if (payload && typeof payload === "object") stats = payload as JsonObject;
    } catch {
      // Health remains useful even when optional statistics are unavailable.
    }
  }

  let analytics: JsonObject = {};
  let analyticsPeriodDays = 7;
  let runtime: JsonObject = {};
  try {
    const [analyticsPayload, runtimePayload] = await Promise.all([
      requestJson(`/api/control/analytics?days=7&profile=${encodeURIComponent(profile)}`, undefined, 4_000),
      requestJson("/api/control/status?profile=default", undefined, 4_000),
    ]);
    if (analyticsPayload && typeof analyticsPayload === "object") {
      const root = analyticsPayload as JsonObject;
      analyticsPeriodDays = numberFrom(root, ["period_days"], 7);
      analytics = root.totals && typeof root.totals === "object" ? root.totals as JsonObject : root;
    }
    if (runtimePayload && typeof runtimePayload === "object") runtime = runtimePayload as JsonObject;
  } catch {
    // Dashboard operations data is optional while the authenticated BFF starts.
  }

  const hasAnalytics = Object.keys(analytics).length > 0;
  const inputTokens = numberFrom(analytics, ["total_input", "input_tokens"], 0);
  const outputTokens = numberFrom(analytics, ["total_output", "output_tokens"], 0);
  const estimatedCost = numberFrom(analytics, ["total_estimated_cost", "estimated_cost", "estimated_cost_usd"], 0);
  const actualCost = numberFrom(analytics, ["total_actual_cost", "actual_cost", "actual_cost_usd"], estimatedCost);
  const gatewayState = String(runtime.gateway_state ?? "").toLowerCase();
  const gateway: ServiceState = runtime.gateway_running === true || ["running", "online", "ready"].includes(gatewayState)
    ? "online"
    : gatewayState === "stopped" || gatewayState === "offline"
      ? "offline"
      : Object.keys(runtime).length
        ? "degraded"
        : "checking";

  return {
    hermes,
    knowledge,
    gateway,
    indexedNotes: numberFrom(stats, ["documents", "notes", "indexed_notes", "node_count", "total_nodes"], 0),
    graphLinks: numberFrom(stats, ["links", "edges", "edge_count", "explicit_links"], 0),
    activeSessions: numberFrom(runtime, ["active_sessions"], 0),
    sessionsInPeriod: hasAnalytics ? numberFrom(analytics, ["total_sessions", "sessions"], 0) : 0,
    tokensToday: hasAnalytics ? numberFrom(analytics, ["total_tokens", "tokens", "token_count"], inputTokens + outputTokens) : 0,
    costToday: hasAnalytics ? numberFrom(analytics, ["total_cost", "cost", "cost_usd"], actualCost) : 0,
    analyticsPeriodDays,
    analyticsLive: hasAnalytics,
    checkedAt: new Date(),
  };
}

function nodeKind(value: unknown): GraphNodeKind {
  return value === "memory" || value === "skill" || value === "insight" || value === "task"
    ? value
    : "note";
}

function normalizeNode(value: unknown, index: number): GraphNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as JsonObject;
  const id = String(node.id ?? node.path ?? node.slug ?? `node-${index}`);
  const title = String(node.title ?? node.label ?? node.name ?? id);
  const tags = Array.isArray(node.tags) ? node.tags.map(String) : [];
  const rawWeight = numberFrom(node, ["weight", "score", "activation"], Number.NaN);
  return {
    id,
    title,
    kind: nodeKind(node.kind ?? node.type),
    summary: String(node.summary ?? node.description ?? node.excerpt ?? "No summary yet."),
    tags,
    weight: rawWeight,
    degree: numberFrom(node, ["degree"], Number.NaN),
    updatedAt: typeof node.updated_at === "string" ? node.updated_at : undefined,
    revision: typeof node.revision === "string" ? node.revision : undefined,
    path: typeof node.path === "string" ? node.path : undefined,
    obsidianUri: typeof node.obsidian_uri === "string" ? node.obsidian_uri : undefined,
    editable: typeof node.editable === "boolean" ? node.editable : undefined,
    deletable: typeof node.deletable === "boolean" ? node.deletable : undefined,
    source: typeof node.source === "string" ? node.source : undefined,
  };
}

function normalizeEdge(value: unknown): GraphEdge | null {
  if (!value || typeof value !== "object") return null;
  const edge = value as JsonObject;
  const rawSource = edge.source ?? edge.from;
  const rawTarget = edge.target ?? edge.to;
  const source = typeof rawSource === "object" && rawSource ? (rawSource as JsonObject).id : rawSource;
  const target = typeof rawTarget === "object" && rawTarget ? (rawTarget as JsonObject).id : rawTarget;
  if (source == null || target == null) return null;
  const relation = String(edge.relation ?? edge.label ?? edge.type ?? "related");
  const normalizedRelation = relation.toLowerCase();
  const kind = /reference|backlink|explicit|derived|wiki|link/.test(normalizedRelation)
    ? "explicit"
    : /tag|co[-_ ]?occurrence|repeat|mention|used with/.test(normalizedRelation)
      ? "co-occurrence"
      : "semantic";
  return {
    source: String(source),
    target: String(target),
    relation,
    weight: numberFrom(edge, ["weight", "score", "strength"], 0.5),
    kind,
  };
}

export async function loadKnowledgeGraph(): Promise<{ graph: KnowledgeGraph; live: boolean }> {
  try {
    // Keep the interactive graph on the fast structural index. Semantic
    // similarity is intentionally requested through explicit discovery flows;
    // materializing it during every initial page load can exceed the browser's
    // bounded request timeout on a mature vault.
    const payload = (await requestJson(`${KNOWLEDGE_BASE}/graph?semantic=false&limit=320`)) as JsonObject;
    const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const rawEdges = Array.isArray(payload.edges)
      ? payload.edges
      : Array.isArray(payload.links)
        ? payload.links
        : [];
    const normalizedNodes = rawNodes.map(normalizeNode).filter((node): node is GraphNode => Boolean(node));
    const nodeIds = new Set(normalizedNodes.map((node) => node.id));
    const kindPriority: Record<NonNullable<GraphEdge["kind"]>, number> = {
      explicit: 0,
      semantic: 1,
      "co-occurrence": 2,
    };
    const candidates = rawEdges
      .map(normalizeEdge)
      .filter((edge): edge is GraphEdge => edge !== null && nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .sort((left, right) => {
        const priority = kindPriority[left.kind ?? "semantic"] - kindPriority[right.kind ?? "semantic"];
        if (priority) return priority;
        const weight = right.weight - left.weight;
        if (weight) return weight;
        return `${left.source}\u0000${left.target}\u0000${left.relation}`.localeCompare(`${right.source}\u0000${right.target}\u0000${right.relation}`);
      });
    const incident = new Map<string, number>();
    const edges: GraphEdge[] = [];
    for (const edge of candidates) {
      if (edges.length >= 1_000) break;
      if ((incident.get(edge.source) ?? 0) >= 12 || (incident.get(edge.target) ?? 0) >= 12) continue;
      edges.push(edge);
      incident.set(edge.source, (incident.get(edge.source) ?? 0) + 1);
      incident.set(edge.target, (incident.get(edge.target) ?? 0) + 1);
    }
    const edgeDegree = new Map<string, number>();
    edges.forEach((edge) => {
      edgeDegree.set(edge.source, (edgeDegree.get(edge.source) ?? 0) + 1);
      edgeDegree.set(edge.target, (edgeDegree.get(edge.target) ?? 0) + 1);
    });
    const graphDegree = (node: GraphNode): number => typeof node.degree === "number" && Number.isFinite(node.degree)
      ? node.degree
      : edgeDegree.get(node.id) ?? 0;
    const maxDegree = Math.max(1, ...normalizedNodes.map(graphDegree));
    const nodes = normalizedNodes.map((node) => {
      const degree = graphDegree(node);
      return {
        ...node,
        degree,
        weight: Number.isFinite(node.weight) ? Math.max(0, Math.min(1, node.weight)) : Math.sqrt(degree / maxDegree),
      };
    });
    return { graph: { nodes, edges }, live: true };
  } catch {
    // Never substitute synthetic nodes for a private knowledge graph. An
    // unavailable index is materially different from the user's own data and
    // must render as an honest empty/offline state.
    return { graph: { nodes: [], edges: [] }, live: false };
  }
}

function normalizeKnowledgeItem(value: unknown, index: number): KnowledgeItem | null {
  const normalized = normalizeNode(value, index);
  if (!normalized || !value || typeof value !== "object") return null;
  const item = value as JsonObject;
  const detailLoaded = Object.hasOwn(item, "content") || Object.hasOwn(item, "text") || Object.hasOwn(item, "body");
  const status = item.status === "permanent" || item.permanent === true
    ? "permanent"
    : item.status === "growing"
      ? "growing"
      : "seed";
  return {
    ...normalized,
    weight: Number.isFinite(normalized.weight) ? Math.max(0, Math.min(1, normalized.weight)) : 0,
    content: String(item.content ?? item.text ?? item.body ?? normalized.summary),
    status,
    detailLoaded,
  };
}

export async function loadKnowledgeItems(): Promise<{ items: KnowledgeItem[]; live: boolean }> {
  try {
    // The mature vault already exceeds the endpoint's 500-item default. Fetch
    // the documented maximum so Browse/Brainstream never silently omit the
    // tail of the user's knowledge; card rendering remains progressively
    // disclosed in the UI.
    const payload = await requestJson(`${KNOWLEDGE_BASE}/nodes?limit=2000`);
    const rawRecords = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as JsonObject).items)
        ? ((payload as JsonObject).items as unknown[])
        : payload && typeof payload === "object" && Array.isArray((payload as JsonObject).notes)
          ? ((payload as JsonObject).notes as unknown[])
          : [];
    const records = rawRecords.map((record) => {
      if (!record || typeof record !== "object") return record;
      const hit = record as JsonObject;
      if (!hit.node || typeof hit.node !== "object") return record;
      return { ...(hit.node as JsonObject), weight: hit.score };
    });
    const items = records.map(normalizeKnowledgeItem).filter((item): item is KnowledgeItem => Boolean(item));
    return { items, live: true };
  } catch {
    return { items: [], live: false };
  }
}

export async function searchKnowledge(query: string): Promise<KnowledgeItem[]> {
  if (!query.trim()) return [];
  try {
    const payload = await requestJson(`${KNOWLEDGE_BASE}/search?q=${encodeURIComponent(query)}&limit=8`);
    const rawRecords = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as JsonObject).results)
        ? ((payload as JsonObject).results as unknown[])
        : [];
    const records = rawRecords.map((record) => {
      if (!record || typeof record !== "object") return record;
      const hit = record as JsonObject;
      if (!hit.node || typeof hit.node !== "object") return record;
      return { ...(hit.node as JsonObject), weight: hit.score };
    });
    return records.map(normalizeKnowledgeItem).filter((item): item is KnowledgeItem => Boolean(item));
  } catch {
    return [];
  }
}

export async function discoverConnections(seedId?: string): Promise<GraphEdge[]> {
  const payload = await requestJson(`${KNOWLEDGE_BASE}/connections/discover`, {
    method: "POST",
    body: JSON.stringify(seedId ? { node_id: seedId } : {}),
  }, 20_000);
  if (!Array.isArray(payload)) throw new Error("Knowledge returned an invalid discovery result.");
  return payload.flatMap((value): GraphEdge[] => {
    if (!value || typeof value !== "object") return [];
    const connection = value as JsonObject;
    const source = connection.source && typeof connection.source === "object" ? connection.source as JsonObject : {};
    const target = connection.target && typeof connection.target === "object" ? connection.target as JsonObject : {};
    if (typeof source.id !== "string" || typeof target.id !== "string") return [];
    return [{
      source: source.id,
      target: target.id,
      relation: typeof connection.reason === "string" && connection.reason.trim()
        ? connection.reason.trim()
        : "semantic suggestion",
      weight: Math.max(0, Math.min(1, numberFrom(connection, ["score", "semantic_score"], 0))),
      kind: "semantic",
    }];
  });
}

export async function loadGraphActivation(seedId: string) {
  const payload = await requestJson(`${KNOWLEDGE_BASE}/activation`, {
    method: "POST",
    body: JSON.stringify({ seed_ids: [seedId], depth: 3, decay: 0.65, limit: 200, semantic: true }),
  }, 12_000) as JsonObject;
  const rows = Array.isArray(payload.nodes) ? payload.nodes : [];
  const activation = new Map<string, number>();
  rows.forEach((row) => {
    if (!row || typeof row !== "object") return;
    const record = row as JsonObject;
    const node = record.node && typeof record.node === "object" ? record.node as JsonObject : {};
    const id = typeof node.id === "string" ? node.id : "";
    const score = typeof record.activation === "number" ? record.activation : Number.NaN;
    if (id && Number.isFinite(score)) activation.set(id, Math.max(0, Math.min(1, score)));
  });
  return activation;
}

export async function saveKnowledgeItem(item: KnowledgeItem) {
  if (!item.detailLoaded) throw new Error("Load the full note before saving it.");
  if (!item.revision) throw new Error("Refresh this note before saving it.");
  const payload = await requestJson(`${KNOWLEDGE_BASE}/notes/${encodeURIComponent(item.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      title: item.title,
      content: item.content,
      tags: item.tags,
      permanent: item.status === "permanent",
      expected_revision: item.revision,
    }),
  });
  const saved = normalizeKnowledgeItem(payload, 0);
  if (!saved) throw new Error("Knowledge returned an invalid saved note");
  return saved;
}

export async function createKnowledgeItem(item: Pick<KnowledgeItem, "title" | "content" | "tags" | "kind"> & { idempotencyKey?: string }) {
  const payload = await requestJson(`${KNOWLEDGE_BASE}/notes`, {
    method: "POST",
    body: JSON.stringify({
      title: item.title,
      content: item.content,
      tags: item.tags,
      kind: item.kind,
      permanent: false,
      idempotency_key: item.idempotencyKey,
    }),
  });
  const created = normalizeKnowledgeItem(payload, 0);
  if (!created?.revision) throw new Error("Knowledge returned an invalid created note.");
  return created;
}

export async function loadKnowledgeVault(): Promise<KnowledgeVault | null> {
  try {
    const payload = await requestJson(`${KNOWLEDGE_BASE}/vault`) as JsonObject;
    if (typeof payload.name !== "string" || !payload.name.trim()) return null;
    return {
      name: payload.name,
      format: typeof payload.format === "string" ? payload.format : "obsidian-markdown",
      openUri: typeof payload.obsidian_uri === "string" ? payload.obsidian_uri : undefined,
      autoIndex: payload.auto_index === true,
      scanIntervalSeconds: numberFrom(payload, ["scan_interval_seconds"], 0),
    };
  } catch {
    return null;
  }
}

export async function loadKnowledgeItem(id: string) {
  const payload = await requestJson(`${KNOWLEDGE_BASE}/nodes/${encodeURIComponent(id)}`);
  return normalizeKnowledgeItem(payload, 0);
}

export async function promoteKnowledgeItem(id: string, revision?: string) {
  if (!revision) throw new Error("Refresh this note before promoting it.");
  const payload = await requestJson(`${KNOWLEDGE_BASE}/notes/${encodeURIComponent(id)}/promote`, {
    method: "POST",
    body: JSON.stringify({ expected_revision: revision }),
  });
  const promoted = normalizeKnowledgeItem(payload, 0);
  if (!promoted) throw new Error("Knowledge returned an invalid promoted note");
  return promoted;
}

type StreamHandlers = {
  onText: (text: string) => void;
  onTool: (tool: ToolTrace) => void;
};

export async function streamHermesChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  profile: string,
  provider: string,
  model: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
) {
  const response = await fetch(`${HERMES_BASE}/p/${encodeURIComponent(profile)}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ provider, model, messages, stream: true }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Hermes returned ${response.status}`);
  }
  if (!response.body) throw new Error("Hermes returned an empty stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  const tools = new Map<string, ToolTrace>();

  const consume = (line: string) => {
    line = line.replace(/\r$/, "");
    if (!line) {
      eventName = "message";
      return;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      return;
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let packet: JsonObject;
    try {
      packet = JSON.parse(data) as JsonObject;
    } catch {
      return;
    }
    if (eventName === "hermes.tool.progress") {
      const id = String(packet.toolCallId ?? "").trim();
      if (!id) return;
      const previous = tools.get(id);
      const next: ToolTrace = {
        id,
        name: String(packet.tool ?? packet.name ?? previous?.name ?? "tool"),
        input: typeof packet.label === "string" ? packet.label : previous?.input,
        output: typeof packet.error === "string" ? packet.error : typeof packet.output === "string" ? packet.output : previous?.output,
        status: packet.status === "completed" ? "complete" : packet.status === "failed" || packet.status === "error" ? "error" : "running",
      };
      tools.set(id, next);
      handlers.onTool(next);
      return;
    }
    const choices = Array.isArray(packet.choices) ? packet.choices : [];
    const first = choices[0] as JsonObject | undefined;
    const delta = first?.delta as JsonObject | undefined;
    if (typeof delta?.content === "string") handlers.onText(delta.content);
    const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    calls.forEach((rawCall, fallbackIndex) => {
      if (!rawCall || typeof rawCall !== "object") return;
      const call = rawCall as JsonObject;
      const index = typeof call.index === "number" ? call.index : fallbackIndex;
      const key = `openai-${index}`;
      const fn = call.function && typeof call.function === "object" ? (call.function as JsonObject) : {};
      const previous = tools.get(key);
      const next: ToolTrace = {
        id: String(call.id ?? previous?.id ?? `tool-${index}`),
        name: `${previous?.name ?? ""}${typeof fn.name === "string" ? fn.name : ""}` || "tool",
        input: `${previous?.input ?? ""}${typeof fn.arguments === "string" ? fn.arguments : ""}`,
        status: first?.finish_reason === "tool_calls" ? "complete" : "running",
      };
      tools.set(key, next);
      handlers.onTool(next);
    });
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(consume);
    if (done) break;
  }
  if (buffer) consume(buffer);
  for (const tool of tools.values()) {
    if (tool.status === "running") handlers.onTool({ ...tool, status: "complete" });
  }
}

export async function reindexKnowledge() {
  return requestJson(`${KNOWLEDGE_BASE}/index`, { method: "POST", body: "{}" }, 60_000);
}

function relativeTime(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function normalizeAutomation(value: unknown, index: number): Automation | null {
  if (!value || typeof value !== "object") return null;
  const job = value as JsonObject;
  const latest = job.latest_execution && typeof job.latest_execution === "object" ? job.latest_execution as JsonObject : {};
  const enabled = job.enabled !== false && job.paused !== true && job.state !== "paused";
  const status = latest.status === "running" || job.status === "running" || job.state === "running"
    ? "running"
    : latest.status === "failed" || latest.status === "error" || job.status === "failed" || job.state === "error" || job.last_status === "failed" || job.last_status === "error"
      ? "failed"
      : "idle";
  const scheduleRecord = job.schedule && typeof job.schedule === "object" ? job.schedule as JsonObject : {};
  const schedule = typeof job.schedule_display === "string"
    ? job.schedule_display
    : typeof job.schedule === "string"
      ? job.schedule
      : String(scheduleRecord.display ?? scheduleRecord.expr ?? scheduleRecord.value ?? scheduleRecord.run_at ?? "");
  return {
    id: String(job.id ?? `job-${index}`),
    name: String(job.name ?? `Automation ${index + 1}`),
    description: String(job.prompt ?? job.description ?? "Hermes scheduled task"),
    schedule,
    humanSchedule: String((job.schedule_display ?? job.schedule_human ?? job.human_schedule ?? schedule) || "Unscheduled"),
    nextRun: relativeTime(job.next_run_at, "pending"),
    lastRun: relativeTime(latest.started_at ?? job.last_run_at, "Never"),
    enabled,
    status,
    skill: Array.isArray(job.skills) && job.skills.length ? String(job.skills[0]) : "No skill",
    skills: Array.isArray(job.skills) ? job.skills.map(String) : [],
    deliver: typeof job.deliver === "string" ? job.deliver : undefined,
    provider: typeof job.provider === "string" ? job.provider : undefined,
    model: typeof job.model === "string" ? job.model : undefined,
    baseUrl: typeof job.base_url === "string" ? job.base_url : undefined,
    contextFrom: Array.isArray(job.context_from) ? job.context_from.map(String) : undefined,
    enabledToolsets: Array.isArray(job.enabled_toolsets) ? job.enabled_toolsets.map(String) : undefined,
    workdir: typeof job.workdir === "string" ? job.workdir : undefined,
    script: typeof job.script === "string" ? job.script : undefined,
    noAgent: job.no_agent === true,
    runCount: numberFrom(job, ["run_count", "runs"], numberFrom(latest, ["run_count"], 0)),
    lastStatus: String(job.last_status ?? latest.status ?? "never"),
    lastError: typeof job.last_error === "string" ? job.last_error : undefined,
    revision: typeof job._revision === "string" ? job._revision : undefined,
  };
}

export async function loadAutomations(profile = "default"): Promise<{ items: Automation[]; live: boolean }> {
  try {
    const payload = await requestJson(`/api/control/cron?profile=${encodeURIComponent(profile)}`, undefined, 8_000);
    const records = Array.isArray(payload) ? payload : [];
    const items = records.map(normalizeAutomation).filter((item): item is Automation => Boolean(item));
    return { items, live: true };
  } catch {
    return { items: [], live: false };
  }
}

export async function createHermesAutomation(input: { name: string; schedule: string; prompt: string; skills?: string[]; profile?: string }) {
  const payload = await requestJson("/api/control/cron", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      deliver: "local",
      skills: input.skills ?? [],
      profile: input.profile || "default",
    }),
  }, 12_000);
  const created = normalizeAutomation(payload, 0);
  if (!created?.revision) throw new Error("Hermes returned an invalid cron job.");
  return created;
}

export async function loadHermesSkills(profile = "default"): Promise<string[]> {
  const payload = await requestJson(`/api/control/skills?profile=${encodeURIComponent(profile)}`, undefined, 8_000);
  if (!Array.isArray(payload)) throw new Error("Hermes returned an invalid skill list.");
  return payload.flatMap((value) => value && typeof value === "object" && typeof (value as JsonObject).name === "string"
    ? [String((value as JsonObject).name)]
    : []);
}

export async function setHermesAutomationEnabled(id: string, enabled: boolean, profile = "default", revision?: string) {
  const payload = await requestJson(`/api/control/cron/${encodeURIComponent(id)}/${enabled ? "resume" : "pause"}?profile=${encodeURIComponent(profile)}`, {
    method: "POST",
    body: JSON.stringify({ expected_revision: revision }),
  }, 12_000);
  return normalizeAutomation(payload, 0);
}

export async function triggerHermesAutomation(id: string, profile = "default", revision?: string) {
  const payload = await requestJson(`/api/control/cron/${encodeURIComponent(id)}/trigger?profile=${encodeURIComponent(profile)}`, {
    method: "POST",
    body: JSON.stringify({ expected_revision: revision }),
  }, 12_000);
  return normalizeAutomation(payload, 0);
}

function normalizeSession(value: unknown, index: number): Session | null {
  if (!value || typeof value !== "object") return null;
  const session = value as JsonObject;
  const modelConfig = session.model_config && typeof session.model_config === "object" ? session.model_config as JsonObject : {};
  const inputTokens = numberFrom(session, ["input_tokens", "total_input"], 0);
  const outputTokens = numberFrom(session, ["output_tokens", "total_output"], 0);
  return {
    id: String(session.id ?? session.session_id ?? `session-${index}`),
    title: String(session.title ?? session.name ?? "Untitled session"),
    preview: String(session.preview ?? session.last_message ?? session.summary ?? "Open the session to inspect its transcript."),
    model: String(session.model ?? modelConfig.model ?? session.provider ?? "Hermes"),
    tokens: numberFrom(session, ["total_tokens", "tokens", "token_count"], inputTokens + outputTokens),
    cost: numberFrom(session, ["actual_cost_usd", "estimated_cost_usd", "cost", "estimated_cost", "cost_usd"], 0),
    tools: numberFrom(session, ["tool_call_count", "tool_calls", "tools", "tool_count"], 0),
    createdAt: relativeTime(session.last_active ?? session.updated_at ?? session.started_at ?? session.created_at, "Recent"),
    status: session.status === "failed" ? "failed" : session.is_active === true || session.status === "active" ? "active" : "complete",
    source: typeof session.source === "string" ? session.source : undefined,
    messageCount: numberFrom(session, ["message_count", "messages"], 0),
    archived: session.archived === true,
    pinned: session.pinned === true,
  };
}

export async function loadSessions(query = "", options: { source?: string; archived?: "exclude" | "include" | "only"; profile?: string } = {}): Promise<{ items: Session[]; live: boolean }> {
  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (options.source) params.set("source", options.source);
    if (options.archived) params.set("archived", options.archived);
    if (options.profile) params.set("profile", options.profile);
    const payload = await requestJson(`/api/control/sessions${params.size ? `?${params}` : ""}`, undefined, 8_000) as JsonObject;
    const records = Array.isArray(payload.sessions)
      ? payload.sessions
      : Array.isArray(payload.results)
        ? payload.results
        : [];
    const items = records.map(normalizeSession).filter((item): item is Session => Boolean(item));
    return { items, live: true };
  } catch {
    return { items: [], live: false };
  }
}

export async function updateHermesSession(id: string, updates: { title?: string; archived?: boolean; pinned?: boolean; profile?: string }) {
  return requestJson(`/api/control/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  }, 12_000);
}

export async function deleteHermesSession(id: string, profile = "default") {
  return requestJson(`/api/control/sessions/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" }, 12_000);
}

export async function pruneHermesSessions(input: { olderThanDays: number; source?: string; dryRun: boolean; profile?: string; previewToken?: string }) {
  return requestJson("/api/control/sessions/prune", {
    method: "POST",
    body: JSON.stringify({
      older_than_days: input.olderThanDays,
      source: input.source || undefined,
      dry_run: input.dryRun,
      profile: input.profile || "default",
      preview_token: input.previewToken || undefined,
    }),
  }, 60_000) as Promise<{
    ok?: boolean;
    matched?: number;
    removed?: number;
    candidate_count?: number;
    protected_pinned?: number;
    protected_archived?: number;
    protected_active?: number;
    protected_unverified?: number;
    protected_after_preview?: number;
    failed?: number;
    too_many?: boolean;
    limit?: number;
    preview_token?: string;
    expires_in_seconds?: number;
  }>;
}

export async function updateHermesAutomation(id: string, updates: { name: string; schedule: string; prompt: string; skills?: string[]; profile?: string; revision?: string }) {
  if (!updates.revision) throw new Error("Refresh this automation before editing it.");
  const payload = await requestJson(`/api/control/cron/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ name: updates.name, schedule: updates.schedule, prompt: updates.prompt, skills: updates.skills ?? [], profile: updates.profile || "default", expected_revision: updates.revision }),
  }, 12_000);
  const updated = normalizeAutomation(payload, 0);
  if (!updated?.revision) throw new Error("Hermes returned an invalid cron job.");
  return updated;
}

export async function deleteHermesAutomation(id: string, profile = "default", revision?: string) {
  if (!revision) throw new Error("Refresh this automation before deleting it.");
  return requestJson(`/api/control/cron/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE", body: JSON.stringify({ expected_revision: revision }) }, 12_000);
}

export async function loadHermesAutomationRuns(id: string, profile = "default") {
  const payload = await requestJson(`/api/control/cron/${encodeURIComponent(id)}/runs?profile=${encodeURIComponent(profile)}`, undefined, 12_000) as JsonObject;
  return Array.isArray(payload.runs) ? payload.runs as JsonObject[] : [];
}

function messageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as JsonObject;
      return typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

export async function loadSessionTranscript(sessionId: string, profile = "default"): Promise<SessionTraceEntry[]> {
  const payload = await requestJson(`/api/control/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}`, undefined, 8_000) as JsonObject;
  const records = Array.isArray(payload.messages) ? payload.messages : [];
  return records.flatMap((record, index) => {
    if (!record || typeof record !== "object") return [];
    const envelope = record as JsonObject;
    const message = envelope.message && typeof envelope.message === "object"
      ? envelope.message as JsonObject
      : envelope;
    const rawRole = String(message.role ?? "assistant");
    const role: SessionTraceEntry["role"] = rawRole === "user" || rawRole === "tool" || rawRole === "system"
      ? rawRole
      : "assistant";
    const id = String(message.id ?? envelope.id ?? `${sessionId}-${index}`);
    const content = messageContent(message.content ?? message.text);
    const entries: SessionTraceEntry[] = [];

    if (role === "tool") {
      const name = String(message.name ?? message.tool_name ?? "tool");
      entries.push({
        id,
        role,
        content: "",
        tool: {
          id: String(message.tool_call_id ?? id),
          name,
          status: "complete",
          output: content || "Tool completed without textual output.",
        },
      });
      return entries;
    }

    if (content) entries.push({ id, role, content });
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    calls.forEach((rawCall, callIndex) => {
      if (!rawCall || typeof rawCall !== "object") return;
      const call = rawCall as JsonObject;
      const fn = call.function && typeof call.function === "object" ? call.function as JsonObject : {};
      entries.push({
        id: `${id}-tool-${callIndex}`,
        role: "tool",
        content: "",
        tool: {
          id: String(call.id ?? `${id}-${callIndex}`),
          name: String(fn.name ?? call.name ?? "tool"),
          input: messageContent(fn.arguments ?? call.arguments),
          status: "complete",
        },
      });
    });
    return entries;
  });
}

function normalizedProvider(value: unknown): Profile["provider"] {
  return typeof value === "string" && value.trim() ? value.trim() : "custom";
}

function profileLabel(identifier: string) {
  return identifier
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export async function loadHermesProfiles(seed: Profile[]): Promise<{ items: Profile[]; live: boolean; defaultId?: string }> {
  try {
    const [profilePayload, activePayload] = await Promise.all([
      requestJson("/api/control/profiles", undefined, 8_000),
      requestJson("/api/control/profiles/active", undefined, 8_000),
    ]);
    const payload = profilePayload as JsonObject;
    const records = Array.isArray(payload.profiles) ? payload.profiles : [];
    const accents = ["mint", "violet", "amber", "blue"];
    const items = records.flatMap((record, index) => {
      if (!record || typeof record !== "object") return [];
      const row = record as JsonObject;
      const id = String(row.name ?? "").trim();
      if (!id) return [];
      const fallback = seed.find((item) => item.id === id);
      return [{
        id,
        name: fallback?.name ?? profileLabel(id),
        provider: normalizedProvider(row.provider),
        model: String(row.model ?? fallback?.model ?? "unconfigured"),
        description: String(row.description ?? fallback?.description ?? "Hermes runtime profile."),
        context: fallback?.context ?? "Auto",
        temperature: fallback?.temperature ?? 0.2,
        accent: fallback?.accent ?? accents[index % accents.length],
        revision: typeof row._revision === "string" ? row._revision : undefined,
      } satisfies Profile];
    });
    if (!items.length) throw new Error("Hermes returned no profiles");
    const defaultRow = records.find((record) => record && typeof record === "object" && (record as JsonObject).is_default === true) as JsonObject | undefined;
    const active = activePayload && typeof activePayload === "object" ? activePayload as JsonObject : {};
    return { items, live: true, defaultId: typeof active.active === "string" ? active.active : typeof defaultRow?.name === "string" ? defaultRow.name : undefined };
  } catch {
    return { items: seed, live: false, defaultId: seed[0]?.id };
  }
}

export async function updateHermesProfileModel(profileId: string, provider: string, model: string, revision?: string) {
  const payload = await requestJson(`/api/control/profiles/${encodeURIComponent(profileId)}/model`, {
    method: "PUT",
    body: JSON.stringify({ provider, model, expected_revision: revision }),
  }, 12_000);
  if (!payload || typeof payload !== "object" || (payload as JsonObject).ok !== true) {
    throw new Error("Hermes did not accept the profile update");
  }
  return payload as JsonObject;
}

export async function setHermesActiveProfile(profileId: string, revision?: string) {
  const payload = await requestJson("/api/control/profiles/active", {
    method: "POST",
    body: JSON.stringify({ name: profileId, expected_revision: revision }),
  }, 12_000);
  if (!payload || typeof payload !== "object" || (payload as JsonObject).ok !== true) {
    throw new Error("Hermes did not accept the active profile change");
  }
  return payload as JsonObject;
}
