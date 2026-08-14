"use client";

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Boxes,
  Clock3,
  Cpu,
  FileText,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  TerminalSquare,
  Wifi,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import styles from "./hermes-runtime.module.css";

type JsonRecord = Record<string, unknown>;
type Tone = "good" | "warn" | "bad" | "muted";

export type HermesRuntimeViewProps = {
  profileId: string;
};

type PollState<T> = {
  data: T | null;
  error: string;
  loading: boolean;
  source: string;
  updatedAt: Date | null;
};

type PollResult<T> = PollState<T> & {
  refresh: () => void;
};

type RuntimeStatus = {
  version: string | null;
  overall: string | null;
  gatewayRunning: boolean | null;
  gatewayState: string | null;
  activeSessions: number | null;
  components: RuntimeComponent[];
};

type RuntimeComponent = {
  id: string;
  label: string;
  state: string;
  detail: string | null;
};

type PlatformStatus = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  gatewayRunning: boolean;
  state: string;
  error: string | null;
};

type LogsPayload = {
  file: string;
  lines: string[];
};

type DailyUsage = {
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  estimatedCost: number;
  actualCost: number;
  sessions: number;
  apiCalls: number;
};

type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  estimatedCost: number;
  actualCost: number;
  sessions: number;
  apiCalls: number;
};

type UsagePayload = {
  daily: DailyUsage[];
  totals: UsageTotals;
  periodDays: number;
};

type ModelUsage = {
  id: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  estimatedCost: number;
  actualCost: number;
  sessions: number;
  apiCalls: number;
  toolCalls: number;
};

const toneClass: Record<Tone, string> = {
  good: styles.toneGood,
  warn: styles.toneWarn,
  bad: styles.toneBad,
  muted: styles.toneMuted,
};

const logFiles = ["agent", "gateway", "mcp", "errors", "desktop", "gui"] as const;
const logLevels = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;
const analyticsPeriods = [7, 30, 90] as const;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result || null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function labelFromId(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function statusTone(value: string | null | undefined): Tone {
  const state = (value ?? "").toLowerCase();
  if (/^(ok|online|running|ready|healthy|connected|active|configured|enabled)$/.test(state)) return "good";
  if (/error|failed|offline|stopped|unhealthy|critical|degraded/.test(state)) return "bad";
  if (/warn|starting|pending|idle|unknown|unconfigured|disabled|disconnected/.test(state)) return "warn";
  return "muted";
}

function firstText(source: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asText(source[key]);
    if (value) return value;
  }
  return null;
}

function normalizeRuntimeStatus(value: unknown): RuntimeStatus {
  const source = asRecord(value) ?? {};
  const rawComponents = asRecord(source.components) ?? {};
  const components = Object.entries(rawComponents).map(([id, raw]): RuntimeComponent => {
    const component = asRecord(raw);
    if (!component) {
      return {
        id,
        label: labelFromId(id),
        state: asText(raw) ?? "unknown",
        detail: null,
      };
    }
    const configured = asOptionalNumber(component.configured);
    const connected = asOptionalNumber(component.connected);
    const counts = configured !== null || connected !== null
      ? `${connected ?? 0} connected · ${configured ?? 0} configured`
      : null;
    return {
      id,
      label: labelFromId(id),
      state: firstText(component, ["state", "status", "overall", "health"]) ?? "unknown",
      detail: counts ?? firstText(component, ["message", "detail", "selftest"]),
    };
  });

  const rawGatewayRunning = source.gateway_running;
  const gatewayRunning = typeof rawGatewayRunning === "boolean"
    ? rawGatewayRunning
    : rawGatewayRunning === 0 || rawGatewayRunning === 1
      ? Boolean(rawGatewayRunning)
      : null;

  return {
    version: firstText(source, ["version", "hermes_version", "agent_version"]),
    overall: firstText(source, ["overall", "status"]),
    gatewayRunning,
    gatewayState: firstText(source, ["gateway_state", "gateway_status"]),
    activeSessions: asOptionalNumber(source.active_sessions),
    components,
  };
}

function normalizePlatforms(value: unknown): PlatformStatus[] {
  const source = asRecord(value);
  const records = Array.isArray(value)
    ? value
    : Array.isArray(source?.platforms)
      ? source.platforms
      : [];
  return records.flatMap((raw, index): PlatformStatus[] => {
    const platform = asRecord(raw);
    if (!platform) return [];
    const id = firstText(platform, ["id", "slug", "name"]) ?? `platform-${index}`;
    const state = firstText(platform, ["state", "status"])
      ?? (asBoolean(platform.gateway_running) ? "running" : asBoolean(platform.enabled) ? "enabled" : "disabled");
    return [{
      id,
      name: firstText(platform, ["name", "label"]) ?? labelFromId(id),
      description: firstText(platform, ["description"]) ?? "",
      enabled: asBoolean(platform.enabled),
      configured: asBoolean(platform.configured),
      gatewayRunning: asBoolean(platform.gateway_running),
      state,
      error: firstText(platform, ["error_message", "error", "detail"]),
    }];
  }).sort((left, right) => {
    const leftPriority = Number(left.configured) + Number(left.enabled) + Number(left.gatewayRunning);
    const rightPriority = Number(right.configured) + Number(right.enabled) + Number(right.gatewayRunning);
    return rightPriority - leftPriority || left.name.localeCompare(right.name);
  });
}

function normalizeLogs(value: unknown): LogsPayload {
  const source = asRecord(value) ?? {};
  return {
    file: firstText(source, ["file"]) ?? "agent",
    lines: Array.isArray(source.lines)
      ? source.lines.filter((line): line is string => typeof line === "string")
      : [],
  };
}

function normalizeDailyUsage(value: unknown): DailyUsage | null {
  const row = asRecord(value);
  if (!row) return null;
  const day = firstText(row, ["day", "date"]);
  if (!day) return null;
  return {
    day,
    inputTokens: asNumber(row.input_tokens),
    outputTokens: asNumber(row.output_tokens),
    cacheReadTokens: asNumber(row.cache_read_tokens),
    reasoningTokens: asNumber(row.reasoning_tokens),
    estimatedCost: asNumber(row.estimated_cost),
    actualCost: asNumber(row.actual_cost),
    sessions: asNumber(row.sessions),
    apiCalls: asNumber(row.api_calls),
  };
}

function normalizeTotals(value: unknown): UsageTotals {
  const totals = asRecord(value) ?? {};
  return {
    inputTokens: asNumber(totals.total_input ?? totals.input_tokens),
    outputTokens: asNumber(totals.total_output ?? totals.output_tokens),
    cacheReadTokens: asNumber(totals.total_cache_read ?? totals.cache_read_tokens),
    reasoningTokens: asNumber(totals.total_reasoning ?? totals.reasoning_tokens),
    estimatedCost: asNumber(totals.total_estimated_cost ?? totals.estimated_cost),
    actualCost: asNumber(totals.total_actual_cost ?? totals.actual_cost),
    sessions: asNumber(totals.total_sessions ?? totals.sessions),
    apiCalls: asNumber(totals.total_api_calls ?? totals.api_calls),
  };
}

function normalizeUsage(value: unknown, requestedDays: number): UsagePayload {
  const source = asRecord(value) ?? {};
  const daily = Array.isArray(source.daily)
    ? source.daily.map(normalizeDailyUsage).filter((row): row is DailyUsage => row !== null)
    : [];
  daily.sort((left, right) => left.day.localeCompare(right.day));
  return {
    daily,
    totals: normalizeTotals(source.totals ?? source),
    periodDays: asOptionalNumber(source.period_days) ?? requestedDays,
  };
}

function normalizeModels(value: unknown): ModelUsage[] {
  const source = asRecord(value);
  const records = Array.isArray(value)
    ? value
    : Array.isArray(source?.models)
      ? source.models
      : [];
  return records.flatMap((raw, index): ModelUsage[] => {
    const model = asRecord(raw);
    if (!model) return [];
    const name = firstText(model, ["model", "name", "id"]);
    if (!name) return [];
    const provider = firstText(model, ["provider", "billing_provider"]) ?? "Unreported provider";
    return [{
      id: `${provider}:${name}:${index}`,
      model: name,
      provider,
      inputTokens: asNumber(model.input_tokens),
      outputTokens: asNumber(model.output_tokens),
      cacheReadTokens: asNumber(model.cache_read_tokens),
      reasoningTokens: asNumber(model.reasoning_tokens),
      estimatedCost: asNumber(model.estimated_cost),
      actualCost: asNumber(model.actual_cost),
      sessions: asNumber(model.sessions),
      apiCalls: asNumber(model.api_calls),
      toolCalls: asNumber(model.tool_calls),
    }];
  }).sort((left, right) => modelTokens(right) - modelTokens(left));
}

function modelTokens(model: ModelUsage): number {
  return model.inputTokens + model.outputTokens;
}

function preferredCost(actual: number, estimated: number): number {
  return actual > 0 ? actual : estimated;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

function formatTimestamp(value: Date | null): string {
  if (!value) return "Not updated yet";
  return `Updated ${value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as unknown;
  const detail = asText(asRecord(payload)?.detail);
  return detail ?? `${response.status} ${response.statusText}`;
}

function usePollingJson<T>(url: string, intervalMs: number): PollResult<T> {
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: "",
    loading: true,
    source: "",
    updatedAt: null,
  });

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | null = null;

    const load = async (initial: boolean) => {
      activeController = new AbortController();
      if (initial) {
        setState((current) => ({
          data: current.source === url ? current.data : null,
          error: "",
          loading: true,
          source: url,
          updatedAt: current.source === url ? current.updatedAt : null,
        }));
      }
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: activeController.signal,
        });
        if (!response.ok) throw new Error(await responseError(response));
        const data = await response.json() as T;
        if (!stopped) {
          setState({ data, error: "", loading: false, source: url, updatedAt: new Date() });
        }
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) {
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "The request failed.",
            loading: false,
            source: url,
          }));
        }
      } finally {
        if (!stopped) timer = window.setTimeout(() => void load(false), intervalMs);
      }
    };

    void load(true);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      activeController?.abort();
    };
  }, [intervalMs, refreshToken, url]);

  return { ...state, refresh };
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function SourceState({ loading, error, updatedAt }: Pick<PollState<unknown>, "loading" | "error" | "updatedAt">) {
  if (loading) {
    return <span className={styles.sourceState} aria-live="polite"><LoaderCircle className={styles.spin} size={13} aria-hidden="true" />Refreshing</span>;
  }
  if (error) {
    return <span className={styles.sourceState} aria-live="polite" title={error}><AlertTriangle size={13} aria-hidden="true" />{updatedAt ? `Refresh failed · cached ${formatTimestamp(updatedAt).replace("Updated ", "")}` : "Unavailable · no successful response"}</span>;
  }
  if (!updatedAt) {
    return <span className={styles.sourceState} aria-live="polite"><Clock3 size={13} aria-hidden="true" />No successful response</span>;
  }
  return (
    <span className={styles.sourceState} aria-live="polite">
      <span className={styles.liveDot} aria-hidden="true" />
      {formatTimestamp(updatedAt)}
    </span>
  );
}

function InlineError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className={styles.inlineError} role="alert">
      <AlertTriangle size={15} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className={styles.loadingPanel} role="status">
      <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function EmptyPanel({ title, copy }: { title: string; copy: string }) {
  return (
    <div className={styles.emptyPanel}>
      <FileText size={20} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

function StateBadge({ value, tone }: { value: string; tone?: Tone }) {
  const resolvedTone = tone ?? statusTone(value);
  return (
    <span className={`${styles.stateBadge} ${toneClass[resolvedTone]}`}>
      <span aria-hidden="true" />
      {value}
    </span>
  );
}

export function RuntimeView({ profileId }: HermesRuntimeViewProps) {
  const [logFile, setLogFile] = useState<(typeof logFiles)[number]>("agent");
  const [logLevel, setLogLevel] = useState<(typeof logLevels)[number]>("ALL");
  const [logSearch, setLogSearch] = useState("");
  const debouncedSearch = useDebouncedValue(logSearch.trim(), 250);
  const encodedProfile = encodeURIComponent(profileId || "default");

  const statusRequest = usePollingJson<unknown>(
    `/api/control/status?profile=${encodedProfile}`,
    15_000,
  );
  const platformsRequest = usePollingJson<unknown>(
    `/api/control/platforms?profile=${encodedProfile}`,
    15_000,
  );
  const logUrl = useMemo(() => {
    const query = new URLSearchParams({
      profile: profileId || "default",
      file: logFile,
      lines: "200",
      level: logLevel,
    });
    if (debouncedSearch) query.set("search", debouncedSearch);
    return `/api/control/logs?${query.toString()}`;
  }, [debouncedSearch, logFile, logLevel, profileId]);
  const logsRequest = usePollingJson<unknown>(logUrl, 3_000);

  const runtime = useMemo(
    () => statusRequest.data === null ? null : normalizeRuntimeStatus(statusRequest.data),
    [statusRequest.data],
  );
  const platforms = useMemo(
    () => platformsRequest.data === null ? [] : normalizePlatforms(platformsRequest.data),
    [platformsRequest.data],
  );
  const logs = useMemo(
    () => logsRequest.data === null ? null : normalizeLogs(logsRequest.data),
    [logsRequest.data],
  );
  const configuredPlatforms = platforms.filter((platform) => platform.configured).length;
  const runningPlatforms = platforms.filter((platform) => (
    platform.gatewayRunning || /^(running|connected|online|ready)$/i.test(platform.state)
  )).length;

  const refreshAll = () => {
    statusRequest.refresh();
    platformsRequest.refresh();
    logsRequest.refresh();
  };

  return (
    <section className={styles.view} aria-labelledby="runtime-title">
      <header className={styles.viewHeader}>
        <div>
          <p className={styles.eyebrow}>Live operations</p>
          <h1 id="runtime-title">Hermes runtime</h1>
          <p className={styles.lede}>Global agent health and gateway state, plus profile-scoped platforms and the live runtime tail.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.profilePill}>Selected scope · {profileId || "default"}</span>
          <SourceState loading={statusRequest.loading || platformsRequest.loading} error={statusRequest.error || platformsRequest.error} updatedAt={statusRequest.updatedAt ?? platformsRequest.updatedAt} />
          <button type="button" className={styles.refreshButton} onClick={refreshAll} aria-label="Refresh runtime data">
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

      <InlineError message={statusRequest.error} />
      <InlineError message={platformsRequest.error} />

      {runtime === null && statusRequest.loading ? <LoadingPanel label="Reading Hermes runtime status…" /> : (
        <>
          <div className={styles.metricGrid}>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><Cpu size={17} aria-hidden="true" /></span>
              <div><small>Agent version</small><strong>{runtime?.version ?? "Not reported"}</strong></div>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><Activity size={17} aria-hidden="true" /></span>
              <div><small>Overall health</small><strong>{runtime?.overall ?? "Not reported"}</strong></div>
              {runtime?.overall ? <StateBadge value={runtime.overall} /> : null}
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><Server size={17} aria-hidden="true" /></span>
              <div><small>Global gateway</small><strong>{runtime?.gatewayState ?? (runtime?.gatewayRunning === true ? "running" : runtime?.gatewayRunning === false ? "stopped" : "Not reported")}</strong></div>
              {runtime?.gatewayRunning !== null && runtime?.gatewayRunning !== undefined
                ? <StateBadge value={runtime.gatewayRunning ? "online" : "offline"} />
                : null}
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><Boxes size={17} aria-hidden="true" /></span>
              <div><small>Active sessions</small><strong>{runtime?.activeSessions ?? "—"}</strong></div>
            </article>
          </div>

          <div className={styles.runtimeGrid}>
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div><p className={styles.eyebrow}>Subsystems</p><h2>Components</h2></div>
                <span>{runtime?.components.length ?? 0} reported</span>
              </div>
              {runtime?.components.length ? (
                <div className={styles.componentGrid}>
                  {runtime.components.map((component) => (
                    <div className={styles.componentCard} key={component.id}>
                      <div><span className={`${styles.statusOrb} ${toneClass[statusTone(component.state)]}`} aria-hidden="true" /><strong>{component.label}</strong></div>
                      <StateBadge value={component.state} />
                      {component.detail ? <p>{component.detail}</p> : null}
                    </div>
                  ))}
                </div>
              ) : <EmptyPanel title="No component data" copy="Hermes did not report component-level health for this profile." />}
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div><p className={styles.eyebrow}>Gateway channels</p><h2>Messaging platforms</h2></div>
                <span>{runningPlatforms} running · {configuredPlatforms} configured</span>
              </div>
              {platformsRequest.loading && !platforms.length ? <LoadingPanel label="Loading platform states…" /> : platforms.length ? (
                <div className={styles.platformList}>
                  {platforms.map((platform) => (
                    <article className={styles.platformCard} key={platform.id}>
                      <div className={styles.platformIcon}><Wifi size={15} aria-hidden="true" /></div>
                      <div className={styles.platformCopy}>
                        <div><strong>{platform.name}</strong><StateBadge value={platform.state} /></div>
                        {platform.description ? <p>{platform.description}</p> : null}
                        {platform.error ? <small className={styles.platformError}>{platform.error}</small> : null}
                      </div>
                      <dl className={styles.platformFacts}>
                        <div><dt>Configured</dt><dd>{platform.configured ? "Yes" : "No"}</dd></div>
                        <div><dt>Enabled</dt><dd>{platform.enabled ? "Yes" : "No"}</dd></div>
                        <div><dt>Runtime</dt><dd>{platform.gatewayRunning ? "Running" : "Stopped"}</dd></div>
                      </dl>
                    </article>
                  ))}
                </div>
              ) : <EmptyPanel title="No platform catalogue" copy="Hermes returned no messaging platform records for this profile." />}
            </article>
          </div>
        </>
      )}

      <article className={`${styles.panel} ${styles.logsPanel}`}>
        <div className={styles.panelHeader}>
          <div><p className={styles.eyebrow}>Polling every 3 seconds</p><h2>Runtime log tail</h2></div>
          <SourceState loading={logsRequest.loading} error={logsRequest.error} updatedAt={logsRequest.updatedAt} />
        </div>
        <div className={styles.logToolbar}>
          <label className={styles.searchField}>
            <Search size={14} aria-hidden="true" />
            <span className={styles.srOnly}>Search log lines</span>
            <input value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="Search the current log…" />
          </label>
          <label className={styles.selectField}>
            <span>File</span>
            <select value={logFile} onChange={(event) => setLogFile(event.target.value as (typeof logFiles)[number])}>
              {logFiles.map((file) => <option value={file} key={file}>{labelFromId(file)}</option>)}
            </select>
          </label>
          <label className={styles.selectField}>
            <span>Level</span>
            <select value={logLevel} onChange={(event) => setLogLevel(event.target.value as (typeof logLevels)[number])}>
              {logLevels.map((level) => <option value={level} key={level}>{level === "ALL" ? "All levels" : level}</option>)}
            </select>
          </label>
          <button type="button" className={styles.iconButton} onClick={logsRequest.refresh} aria-label="Refresh logs now">
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
        <InlineError message={logsRequest.error} />
        {logsRequest.loading && logs === null ? <LoadingPanel label="Opening the runtime log…" /> : logs?.lines.length ? (
          <div className={styles.logViewport} role="log" aria-label={`${logs.file} log tail`} aria-live="polite">
            <ol>
              {logs.lines.map((line, index) => <li key={`${index}-${line}`}><code>{line}</code></li>)}
            </ol>
          </div>
        ) : <EmptyPanel title="No matching log lines" copy="The selected log is empty or no lines match these filters." />}
      </article>
    </section>
  );
}

function UsageChart({ daily }: { daily: DailyUsage[] }) {
  const titleId = useId();
  const descriptionId = useId();
  const width = 760;
  const height = 270;
  const padding = { top: 24, right: 22, bottom: 42, left: 58 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const totals = daily.map((day) => day.inputTokens + day.outputTokens);
  const maxTokens = Math.max(1, ...totals);
  const x = (index: number) => padding.left + (daily.length <= 1 ? innerWidth / 2 : index / (daily.length - 1) * innerWidth);
  const y = (value: number) => padding.top + innerHeight - value / maxTokens * innerHeight;
  const points = totals.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const areaPoints = `${padding.left},${padding.top + innerHeight} ${points} ${padding.left + innerWidth},${padding.top + innerHeight}`;
  const labelIndexes = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
  const yTicks = [0, 0.5, 1];

  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>Daily token usage</title>
        <desc id={descriptionId}>Input and output token totals for each day in the selected period.</desc>
        <defs>
          <linearGradient id={`${titleId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a5f2cb" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#a5f2cb" stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((tick) => {
          const value = maxTokens * tick;
          const position = y(value);
          return (
            <g key={tick}>
              <line className={styles.chartGridLine} x1={padding.left} x2={padding.left + innerWidth} y1={position} y2={position} />
              <text className={styles.chartAxisLabel} x={padding.left - 10} y={position + 4} textAnchor="end">{compactNumber(value)}</text>
            </g>
          );
        })}
        <polygon points={areaPoints} fill={`url(#${titleId}-fill)`} />
        {daily.length > 1 ? <polyline className={styles.chartLine} points={points} /> : null}
        {daily.map((day, index) => (
          <g key={`${day.day}-${index}`}>
            <circle className={styles.chartPoint} cx={x(index)} cy={y(totals[index])} r="4" />
            <title>{`${day.day}: ${totals[index].toLocaleString()} tokens, ${day.sessions.toLocaleString()} sessions`}</title>
          </g>
        ))}
        {labelIndexes.map((index) => daily[index] ? (
          <text className={styles.chartAxisLabel} key={index} x={x(index)} y={height - 14} textAnchor={index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"}>
            {new Date(`${daily[index].day}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}
          </text>
        ) : null)}
      </svg>
    </div>
  );
}

export function AnalyticsView({ profileId }: HermesRuntimeViewProps) {
  const [days, setDays] = useState<(typeof analyticsPeriods)[number]>(30);
  const encodedProfile = encodeURIComponent(profileId || "default");
  const usageRequest = usePollingJson<unknown>(
    `/api/control/analytics?days=${days}&profile=${encodedProfile}`,
    30_000,
  );
  const modelsRequest = usePollingJson<unknown>(
    `/api/control/analytics/models?days=${days}&profile=${encodedProfile}`,
    30_000,
  );
  const usage = useMemo(
    () => usageRequest.data === null ? null : normalizeUsage(usageRequest.data, days),
    [days, usageRequest.data],
  );
  const models = useMemo(
    () => modelsRequest.data === null ? [] : normalizeModels(modelsRequest.data),
    [modelsRequest.data],
  );
  const maxModelTokens = Math.max(1, ...models.map(modelTokens));
  const totalTokens = usage ? usage.totals.inputTokens + usage.totals.outputTokens : 0;
  const totalCost = usage ? preferredCost(usage.totals.actualCost, usage.totals.estimatedCost) : 0;
  const hasUsage = Boolean(usage && (usage.daily.length || totalTokens || usage.totals.sessions || usage.totals.apiCalls));

  const refreshAll = () => {
    usageRequest.refresh();
    modelsRequest.refresh();
  };

  return (
    <section className={styles.view} aria-labelledby="analytics-title">
      <header className={styles.viewHeader}>
        <div>
          <p className={styles.eyebrow}>Usage intelligence</p>
          <h1 id="analytics-title">Analytics</h1>
          <p className={styles.lede}>Token volume, cost, sessions, and per-model activity from Hermes accounting.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.profilePill}>Profile · {profileId || "default"}</span>
          <SourceState loading={usageRequest.loading || modelsRequest.loading} error={usageRequest.error || modelsRequest.error} updatedAt={usageRequest.updatedAt ?? modelsRequest.updatedAt} />
          <button type="button" className={styles.refreshButton} onClick={refreshAll} aria-label="Refresh analytics data">
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

      <div className={styles.analyticsToolbar}>
        <div className={styles.periodPicker} aria-label="Analytics period">
          {analyticsPeriods.map((period) => (
            <button type="button" key={period} className={days === period ? styles.periodActive : ""} aria-pressed={days === period} onClick={() => setDays(period)}>
              {period} days
            </button>
          ))}
        </div>
        <span><Clock3 size={13} aria-hidden="true" /> Hermes reports {usage?.periodDays ?? days} days</span>
      </div>

      <InlineError message={usageRequest.error} />
      <InlineError message={modelsRequest.error} />

      {usage === null && usageRequest.loading ? <LoadingPanel label="Calculating Hermes usage…" /> : !hasUsage && !models.length ? (
        <EmptyPanel title="No usage in this period" copy="Hermes has not recorded any sessions or billable model activity for this profile and date range." />
      ) : (
        <>
          <div className={styles.metricGrid}>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><BarChart3 size={17} aria-hidden="true" /></span>
              <div><small>Total tokens</small><strong>{compactNumber(totalTokens)}</strong></div>
              <em>{compactNumber(usage?.totals.inputTokens ?? 0)} in · {compactNumber(usage?.totals.outputTokens ?? 0)} out</em>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><Activity size={17} aria-hidden="true" /></span>
              <div><small>Cost</small><strong>{formatCost(totalCost)}</strong></div>
              <em>{usage && usage.totals.actualCost > 0 ? "actual" : "estimated"}</em>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><Boxes size={17} aria-hidden="true" /></span>
              <div><small>Sessions</small><strong>{compactNumber(usage?.totals.sessions ?? 0)}</strong></div>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricIcon}><TerminalSquare size={17} aria-hidden="true" /></span>
              <div><small>API calls</small><strong>{compactNumber(usage?.totals.apiCalls ?? 0)}</strong></div>
            </article>
          </div>

          <div className={styles.analyticsGrid}>
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div><p className={styles.eyebrow}>Input + output</p><h2>Daily token usage</h2></div>
                <span>{usage?.daily.length ?? 0} active days</span>
              </div>
              {usage?.daily.length ? <UsageChart daily={usage.daily} /> : <EmptyPanel title="No daily rows" copy="Hermes returned totals but no day-level usage records." />}
              {usage ? (
                <dl className={styles.tokenLegend}>
                  <div><dt><span className={styles.legendMint} /> Input</dt><dd>{compactNumber(usage.totals.inputTokens)}</dd></div>
                  <div><dt><span className={styles.legendViolet} /> Output</dt><dd>{compactNumber(usage.totals.outputTokens)}</dd></div>
                  <div><dt><span className={styles.legendAmber} /> Cache read</dt><dd>{compactNumber(usage.totals.cacheReadTokens)}</dd></div>
                  <div><dt><span className={styles.legendBlue} /> Reasoning</dt><dd>{compactNumber(usage.totals.reasoningTokens)}</dd></div>
                </dl>
              ) : null}
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div><p className={styles.eyebrow}>Provider accounting</p><h2>Model breakdown</h2></div>
                <span>{models.length} models</span>
              </div>
              {modelsRequest.loading && !models.length ? <LoadingPanel label="Loading model accounting…" /> : models.length ? (
                <div className={styles.modelList}>
                  {models.map((model) => {
                    const tokens = modelTokens(model);
                    const cost = preferredCost(model.actualCost, model.estimatedCost);
                    return (
                      <article className={styles.modelCard} key={model.id}>
                        <div className={styles.modelHeading}>
                          <span><strong>{model.model}</strong><small>{model.provider}</small></span>
                          <span><strong>{compactNumber(tokens)}</strong><small>tokens</small></span>
                        </div>
                        <div className={styles.modelBar} aria-label={`${model.model}: ${tokens.toLocaleString()} tokens`}><span style={{ width: `${tokens > 0 ? Math.max(2, tokens / maxModelTokens * 100) : 0}%` }} /></div>
                        <dl>
                          <div><dt>Cost</dt><dd>{formatCost(cost)}</dd></div>
                          <div><dt>Sessions</dt><dd>{model.sessions.toLocaleString()}</dd></div>
                          <div><dt>API calls</dt><dd>{model.apiCalls.toLocaleString()}</dd></div>
                          <div><dt>Tools</dt><dd>{model.toolCalls.toLocaleString()}</dd></div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
              ) : <EmptyPanel title="No model usage" copy="No model-level accounting rows were recorded in this period." />}
            </article>
          </div>
        </>
      )}
    </section>
  );
}
