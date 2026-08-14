"use client";

import {
  BookOpenText,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleDot,
  Database,
  Eye,
  KeyRound,
  LoaderCircle,
  MemoryStick,
  Network,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./hermes-capabilities.module.css";

type JsonRecord = Record<string, unknown>;
type CapabilityTab = "skills" | "mcp" | "memory";

type SkillRow = {
  name: string;
  description?: string;
  category?: string;
  enabled: boolean;
  usage?: number | JsonRecord;
  provenance?: "agent" | "bundled" | "hub" | string;
};

type McpServer = {
  name: string;
  url?: string;
  command?: string;
  enabled?: boolean;
  status?: string;
  connected?: boolean;
  tool_count?: number;
  revision?: string;
};

type McpTestResult = {
  server: string;
  ok: boolean;
  error?: string;
  tools: Array<{ name: string; description?: string }>;
  prompts: number;
  resources: number;
};

type MemoryProvider = {
  name: string;
  description?: string;
  available?: boolean;
  configured?: boolean;
  status?: string;
};

type MemoryNode = {
  id: string;
  label?: string;
  title?: string;
  kind?: string;
  memorySource?: string;
  timestamp?: string;
};

type MemoryPayload = {
  status?: {
    active?: string;
    providers?: MemoryProvider[];
    builtin_files?: Record<string, unknown>;
  };
  graph?: {
    nodes?: MemoryNode[];
    memory?: Array<{ source?: string; timestamp?: string; title?: string; body?: string }>;
    stats?: JsonRecord;
  };
};

type CredentialEntry = {
  index: number;
  revision: string;
  id?: string;
  label?: string;
  auth_type?: string;
  source?: string;
  priority?: number;
  last_status?: string;
  request_count?: number;
  token_preview?: string;
  has_refresh?: boolean;
};

type CredentialProvider = { provider: string; entries: CredentialEntry[] };

type ConfigValues = {
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

const defaultConfig: ConfigValues = {
  max_live_sessions: 4,
  max_turns: 100,
  gateway_timeout: 900,
  service_tier: "auto",
  reasoning_effort: "medium",
  compression_enabled: true,
  compression_threshold: 0.82,
  streaming_enabled: true,
  streaming_transport: "auto",
  sessions_auto_prune: false,
  sessions_retention_days: 30,
  logging_level: "INFO",
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as JsonRecord | null;
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return payload as T;
}

function LoadingState({ label }: { label: string }) {
  return <div className={styles.state}><LoaderCircle className={styles.spin} size={18} /><span>{label}</span></div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className={`${styles.state} ${styles.error}`}><Unplug size={18} /><span>{message}</span><button type="button" onClick={onRetry}><RefreshCw size={13} /> Retry</button></div>;
}

function ModalError({ message }: { message: string }) {
  if (!message) return null;
  return <div className={styles.modalError} role="alert"><Unplug size={15} /><span>{message}</span></div>;
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className={styles.empty}><CircleDot size={22} /><strong>{title}</strong><span>{copy}</span></div>;
}

function useDialogGuard(open: boolean, locked: boolean, onClose: () => void) {
  const options = useRef({ locked, onClose });
  useEffect(() => { options.current = { locked, onClose }; }, [locked, onClose]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].at(-1);
    if (!dialog) return;
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.classList.contains(styles.scrim));
    const timer = window.setTimeout(() => focusables()[0]?.focus(), 0);
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !options.current.locked) {
        event.preventDefault();
        options.current.onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.contains(document.activeElement)) return;
      const candidates = focusables();
      if (!candidates.length) return;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", listener);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, [open]);
}

function memoryBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return 0;
  const record = value as JsonRecord;
  for (const key of ["bytes", "size", "size_bytes"]) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key] as number;
  }
  return 0;
}

function byteLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function CapabilitiesView({ profileId }: { profileId: string }) {
  const [tab, setTab] = useState<CapabilityTab>("skills");
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [memory, setMemory] = useState<MemoryPayload>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [readyTab, setReadyTab] = useState<CapabilityTab | null>(null);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [busy, setBusy] = useState("");
  const [skillContent, setSkillContent] = useState<{ name: string; content: string } | null>(null);
  const [memoryEditor, setMemoryEditor] = useState<{ id: string; title: string; content: string; revision: string } | null>(null);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpTest, setMcpTest] = useState<McpTestResult | null>(null);
  const [mcpForm, setMcpForm] = useState({ name: "", url: "", auth: "none", bearer_token: "" });
  const loadSequence = useRef(0);
  const closeCapabilityModal = useCallback(() => {
    if (busy) return;
    setSkillContent(null);
    setShowMcpForm(false);
    setMemoryEditor(null);
    setModalError("");
  }, [busy]);
  useDialogGuard(Boolean(skillContent || showMcpForm || memoryEditor), Boolean(busy), closeCapabilityModal);

  const loadTab = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const requestedTab = tab;
    setLoading(true);
    setReadyTab(null);
    setError("");
    setMcpTest(null);
    try {
      if (requestedTab === "skills") {
        const rows = await requestJson<unknown>(`/api/control/skills?profile=${encodeURIComponent(profileId)}`);
        if (!Array.isArray(rows)) throw new Error("Hermes returned an invalid skills catalogue.");
        if (sequence !== loadSequence.current) return;
        setSkills(rows as SkillRow[]);
      } else if (requestedTab === "mcp") {
        const payload = await requestJson<unknown>(`/api/control/mcp?profile=${encodeURIComponent(profileId)}`);
        if (!payload || typeof payload !== "object" || !Array.isArray((payload as JsonRecord).servers)) {
          throw new Error("Hermes returned an invalid MCP catalogue.");
        }
        if (sequence !== loadSequence.current) return;
        setServers((payload as { servers: McpServer[] }).servers);
      } else {
        const payload = await requestJson<unknown>(`/api/control/memory?profile=${encodeURIComponent(profileId)}`);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("Hermes returned an invalid memory payload.");
        }
        if (sequence !== loadSequence.current) return;
        setMemory(payload as MemoryPayload);
      }
      setReadyTab(requestedTab);
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setError(cause instanceof Error ? cause.message : "Hermes did not return this capability.");
      setReadyTab(null);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [profileId, tab]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTab(), 0);
    return () => window.clearTimeout(timer);
  }, [loadTab]);

  const filteredSkills = useMemo(() => {
    const needle = query.toLowerCase().trim();
    return skills.filter((skill) => !needle || `${skill.name} ${skill.description ?? ""} ${skill.category ?? ""}`.toLowerCase().includes(needle));
  }, [query, skills]);
  const controlsReady = readyTab === tab && !loading && !error;

  const toggleSkill = async (skill: SkillRow) => {
    if (!controlsReady || busy) return;
    setBusy(`skill:${skill.name}`);
    setError("");
    try {
      await requestJson("/api/control/skills", {
        method: "PATCH",
        body: JSON.stringify({ name: skill.name, enabled: !skill.enabled, profile: profileId }),
      });
      setSkills((rows) => rows.map((row) => row.name === skill.name ? { ...row, enabled: !row.enabled } : row));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Skill update failed."); }
    finally { setBusy(""); }
  };

  const inspectSkill = async (skill: SkillRow) => {
    if (!controlsReady || busy) return;
    setBusy(`content:${skill.name}`);
    setError("");
    try {
      const payload = await requestJson<{ name?: string; content?: string }>(`/api/control/skills/content?name=${encodeURIComponent(skill.name)}&profile=${encodeURIComponent(profileId)}`);
      setSkillContent({ name: payload.name || skill.name, content: payload.content || "" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Skill content is unavailable."); }
    finally { setBusy(""); }
  };

  const createMcp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controlsReady || busy) {
      setModalError("Reload the live MCP catalogue before adding a server.");
      return;
    }
    if (mcpForm.auth === "oauth") {
      setModalError("OAuth setup is available only in the official Hermes dashboard.");
      return;
    }
    setBusy("mcp:create");
    setModalError("");
    try {
      await requestJson("/api/control/mcp", {
        method: "POST",
        body: JSON.stringify({ ...mcpForm, profile: profileId }),
      });
      setMcpForm({ name: "", url: "", auth: "none", bearer_token: "" });
      setShowMcpForm(false);
      await loadTab();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "MCP server could not be added.";
      setModalError(detail);
      setReadyTab(null);
      setError("The MCP catalogue may have changed. Refresh it before another operation.");
    }
    finally { setBusy(""); }
  };

  const testMcp = async (server: McpServer) => {
    if (!controlsReady || busy) return;
    setBusy(`mcp-test:${server.name}`);
    setMcpTest(null);
    try {
      const payload = await requestJson<unknown>(`/api/control/mcp/${encodeURIComponent(server.name)}/test`, {
        method: "POST",
        body: JSON.stringify({ profile: profileId }),
      });
      if (!payload || typeof payload !== "object" || typeof (payload as JsonRecord).ok !== "boolean") {
        throw new Error("Hermes returned an invalid MCP test result.");
      }
      const result = payload as JsonRecord;
      if (!Array.isArray(result.tools)) throw new Error("Hermes returned an invalid MCP tool list.");
      const rawTools = result.tools;
      const tools = rawTools.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const tool = entry as JsonRecord;
        if (typeof tool.name !== "string" || !tool.name.trim()) return [];
        return [{
          name: tool.name,
          description: typeof tool.description === "string" && tool.description.trim() ? tool.description : undefined,
        }];
      });
      setMcpTest({
        server: server.name,
        ok: result.ok === true,
        error: typeof result.error === "string" && result.error.trim() ? result.error : result.ok === true ? undefined : "Hermes could not connect to this server.",
        tools,
        prompts: typeof result.prompts === "number" && Number.isFinite(result.prompts) ? result.prompts : 0,
        resources: typeof result.resources === "number" && Number.isFinite(result.resources) ? result.resources : 0,
      });
    } catch (cause) {
      setMcpTest({
        server: server.name,
        ok: false,
        error: cause instanceof Error ? cause.message : "MCP test failed.",
        tools: [],
        prompts: 0,
        resources: 0,
      });
    } finally {
      setBusy("");
    }
  };

  const mutateMcp = async (server: McpServer, action: "toggle" | "delete") => {
    if (!controlsReady || busy) return;
    if (action === "delete" && !window.confirm(`Permanently remove MCP server “${server.name}”? Stored authentication may not be recoverable.`)) return;
    setBusy(`mcp:${server.name}`);
    setError("");
    setMcpTest(null);
    try {
      const path = `/api/control/mcp/${encodeURIComponent(server.name)}`;
      if (action === "delete") await requestJson(`${path}?profile=${encodeURIComponent(profileId)}`, { method: "DELETE", body: JSON.stringify({ expected_revision: server.revision }) });
      else await requestJson(path, { method: "PATCH", body: JSON.stringify({ profile: profileId, enabled: server.enabled === false, expected_revision: server.revision }) });
      await loadTab();
    } catch (cause) {
      setReadyTab(null);
      setError(cause instanceof Error ? cause.message : `MCP ${action} failed.`);
    }
    finally { setBusy(""); }
  };

  const openMemory = async (node: MemoryNode) => {
    if (!controlsReady || busy) return;
    setBusy(`memory:${node.id}`);
    setError("");
    setModalError("");
    try {
      const payload = await requestJson<{ content?: string; label?: string; revision?: string }>(`/api/control/memory/node?id=${encodeURIComponent(node.id)}&profile=${encodeURIComponent(profileId)}`);
      setMemoryEditor({ id: node.id, title: payload.label || node.label || node.title || "Memory", content: payload.content || "", revision: payload.revision || "" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Memory content is unavailable."); }
    finally { setBusy(""); }
  };

  const memoryNodes = (memory.graph?.nodes ?? []).filter((node) => node.kind === "memory" || node.id.startsWith("memory:"));
  const providers = memory.status?.providers ?? [];
  const builtinBytes = Object.values(memory.status?.builtin_files ?? {}).reduce<number>((total, value) => total + memoryBytes(value), 0);

  return (
    <div className={styles.surface}>
      <header className={styles.hero}>
        <div><span>Capability registry</span><h1>Skills, MCP & memory</h1><p>Inspect and operate the exact capability surface available to the selected Hermes profile.</p></div>
        <button type="button" className={styles.secondary} onClick={() => void loadTab()} disabled={loading || Boolean(busy)}><RefreshCw size={14} /> Refresh</button>
      </header>
      <div className={styles.tabs} role="tablist" aria-label="Hermes capabilities">
        <button type="button" role="tab" aria-selected={tab === "skills"} onClick={() => setTab("skills")}><BookOpenText size={15} /> Skills <span>{skills.length || "—"}</span></button>
        <button type="button" role="tab" aria-selected={tab === "mcp"} onClick={() => setTab("mcp")}><Network size={15} /> MCP <span>{servers.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}><BrainCircuit size={15} /> Memory <span>{memoryNodes.length}</span></button>
      </div>
      {error ? <ErrorState message={error} onRetry={() => void loadTab()} /> : null}
      {loading ? <LoadingState label={`Loading ${tab} from Hermes…`} /> : null}

      {!loading && readyTab === "skills" && tab === "skills" ? <section>
        <div className={styles.toolbar}><label className={styles.search}><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search installed skills…" /></label><span>{filteredSkills.length} visible · {skills.filter((skill) => skill.enabled).length} enabled</span></div>
        {filteredSkills.length ? <div className={styles.grid}>{filteredSkills.map((skill) => <article className={styles.card} key={skill.name}>
          <div className={styles.cardHead}><span className={styles.emblem}><BookOpenText size={16} /></span><div><small>{skill.category || skill.provenance || "skill"}</small><h2>{skill.name}</h2></div><label className={styles.switch} aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}><input type="checkbox" aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} checked={skill.enabled} onChange={() => void toggleSkill(skill)} disabled={!controlsReady || Boolean(busy)} /><span aria-hidden="true" /></label></div>
          <p>{skill.description || "No description in this SKILL.md."}</p>
          <footer><span className={skill.enabled ? styles.live : styles.muted}><CircleDot size={11} /> {skill.enabled ? "Enabled" : "Disabled"}</span><button type="button" onClick={() => void inspectSkill(skill)} disabled={!controlsReady || Boolean(busy)}>{busy === `content:${skill.name}` ? <LoaderCircle className={styles.spin} size={13} /> : <Eye size={13} />} Read source</button></footer>
        </article>)}</div> : <EmptyState title="No matching skills" copy="Change the query to inspect the installed capability library." />}
      </section> : null}

      {!loading && readyTab === "mcp" && tab === "mcp" ? <section>
        <div className={styles.toolbar}><div><strong>Model Context Protocol servers</strong><span>Remote endpoints are restricted to HTTPS.</span></div><button type="button" className={styles.primary} onClick={() => { setModalError(""); setShowMcpForm(true); }} disabled={!controlsReady || Boolean(busy)}><Plus size={14} /> Add server</button></div>
        {servers.length ? <div className={styles.list}>{servers.map((server) => <article className={styles.row} key={server.name}>
          <span className={styles.emblem}><ServerCog size={16} /></span><div><h2>{server.name}</h2><code>{server.url || server.command || "Configured by Hermes"}</code></div><span className={server.connected || server.status === "connected" ? styles.live : styles.muted}><CircleDot size={11} /> {server.status || (server.connected ? "connected" : server.enabled === false ? "disabled" : "configured")}</span><div className={styles.rowActions}><button type="button" onClick={() => void testMcp(server)} disabled={!controlsReady || Boolean(busy)}>{busy === `mcp-test:${server.name}` ? <LoaderCircle className={styles.spin} size={12} /> : null} Test</button><button type="button" onClick={() => void mutateMcp(server, "toggle")} disabled={!controlsReady || Boolean(busy)}>{server.enabled === false ? "Enable" : "Disable"}</button><button type="button" className={styles.danger} onClick={() => void mutateMcp(server, "delete")} disabled={!controlsReady || Boolean(busy)} aria-label={`Delete ${server.name}`}><Trash2 size={13} /></button></div>
          {mcpTest?.server === server.name ? <div className={`${styles.testResult} ${mcpTest.ok ? styles.testSuccess : styles.testFailure}`} role={mcpTest.ok ? "status" : "alert"}><span>{mcpTest.ok ? <Check size={15} /> : <Unplug size={15} />}</span><div><strong>{mcpTest.ok ? `Connected · ${mcpTest.tools.length} tool${mcpTest.tools.length === 1 ? "" : "s"}` : "Connection failed"}</strong>{mcpTest.error ? <p>{mcpTest.error}</p> : <p>{mcpTest.prompts} prompts · {mcpTest.resources} resources</p>}{mcpTest.tools.length ? <ul>{mcpTest.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code>{tool.description ? <span>{tool.description}</span> : null}</li>)}</ul> : null}</div></div> : null}
        </article>)}</div> : <EmptyState title="No MCP servers configured" copy="Add a remote HTTPS MCP endpoint. Secrets remain in the server-side Hermes store." />}
      </section> : null}

      {!loading && readyTab === "memory" && tab === "memory" ? <section>
        <div className={styles.metrics}><div><MemoryStick size={16} /><span><small>Active provider</small><strong>{memory.status?.active || "Not selected"}</strong></span></div><div><Database size={16} /><span><small>Memory chunks</small><strong>{memoryNodes.length}</strong></span></div><div><ShieldCheck size={16} /><span><small>Available providers</small><strong>{providers.filter((item) => item.available).length} / {providers.length}</strong></span></div><div><BrainCircuit size={16} /><span><small>MEMORY.md + USER.md</small><strong>{byteLabel(builtinBytes)}</strong></span></div></div>
        <div className={styles.split}><div><div className={styles.sectionTitle}><div><span>Content library</span><h2>Learned memory</h2></div><small>Refetched after every mutation</small></div>{memoryNodes.length ? <div className={styles.memoryList}>{memoryNodes.map((node) => <button type="button" key={node.id} onClick={() => void openMemory(node)} disabled={!controlsReady || Boolean(busy)}><BrainCircuit size={15} /><span><strong>{node.label || node.title || "Memory"}</strong><small>{node.memorySource || node.id}</small></span>{busy === `memory:${node.id}` ? <LoaderCircle className={styles.spin} size={13} /> : <ChevronRight size={13} />}</button>)}</div> : <EmptyState title="No learned memory yet" copy="Hermes will populate MEMORY.md and USER.md as it learns." />}</div>
        <aside className={styles.providers}><div className={styles.sectionTitle}><div><span>Runtime</span><h2>Memory providers</h2></div></div>{providers.map((provider) => <div key={provider.name}><span className={styles.emblem}><Database size={14} /></span><span><strong>{provider.name}</strong><small>{provider.description || provider.status || "Memory backend"}</small></span><em className={provider.configured ? styles.live : styles.muted}>{provider.configured ? "ready" : provider.available ? "available" : "offline"}</em></div>)}</aside></div>
      </section> : null}

      {skillContent ? <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="skill-source-title"><button type="button" className={styles.scrim} onClick={() => setSkillContent(null)} aria-label="Close skill source" /><div className={styles.modalCard}><header><div><span>Read-only source</span><h2 id="skill-source-title">{skillContent.name}</h2></div><button type="button" onClick={() => setSkillContent(null)} aria-label="Close"><X size={15} /></button></header><pre>{skillContent.content || "This skill has no content."}</pre></div></div> : null}
      {showMcpForm ? <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="mcp-form-title"><button type="button" className={styles.scrim} onClick={() => { setShowMcpForm(false); setModalError(""); }} aria-label="Close MCP form" disabled={Boolean(busy)} /><form className={styles.formCard} onSubmit={(event) => void createMcp(event)} aria-busy={busy === "mcp:create"}><header><div><span>Remote capability</span><h2 id="mcp-form-title">Add MCP server</h2></div><button type="button" onClick={() => { setShowMcpForm(false); setModalError(""); }} aria-label="Close" disabled={Boolean(busy)}><X size={15} /></button></header><ModalError message={modalError} /><label><span>Name</span><input required pattern="[A-Za-z0-9](?:[A-Za-z0-9_.]|-)*" value={mcpForm.name} onChange={(event) => setMcpForm((value) => ({ ...value, name: event.target.value }))} placeholder="research-tools" disabled={Boolean(busy) || !controlsReady} /></label><label><span>HTTPS endpoint</span><input required type="url" value={mcpForm.url} onChange={(event) => setMcpForm((value) => ({ ...value, url: event.target.value }))} placeholder="https://mcp.example.com" disabled={Boolean(busy) || !controlsReady} /></label><label><span>Authentication</span><select value={mcpForm.auth} onChange={(event) => setMcpForm((value) => ({ ...value, auth: event.target.value }))} disabled={Boolean(busy) || !controlsReady}><option value="none">None</option><option value="oauth" disabled>OAuth — use official Hermes dashboard</option><option value="header">Bearer header</option></select></label><p className={styles.oauthNotice}>OAuth authorization is intentionally not started by HERMESS yet. Add OAuth servers from the official Hermes dashboard. <a href="https://github.com/NousResearch/hermes-agent/blob/v2026.8.3/website/docs/user-guide/features/web-dashboard.md" target="_blank" rel="noreferrer">Dashboard guide</a></p>{mcpForm.auth === "header" ? <label><span>Bearer token</span><input required type="password" autoComplete="new-password" value={mcpForm.bearer_token} onChange={(event) => setMcpForm((value) => ({ ...value, bearer_token: event.target.value }))} disabled={Boolean(busy) || !controlsReady} /></label> : null}<footer><button type="button" className={styles.secondary} onClick={() => { setShowMcpForm(false); setModalError(""); }} disabled={Boolean(busy)}>Cancel</button><button type="submit" className={styles.primary} disabled={Boolean(busy) || !controlsReady}>{busy === "mcp:create" ? <LoaderCircle className={styles.spin} size={14} /> : <Plus size={14} />} Add server</button></footer></form></div> : null}
      {memoryEditor ? <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="memory-editor-title"><button type="button" className={styles.scrim} onClick={() => { setMemoryEditor(null); setModalError(""); }} aria-label="Close memory source" /><div className={styles.formCard}><header><div><span>Read-only Hermes learning graph</span><h2 id="memory-editor-title">{memoryEditor.title}</h2></div><button type="button" onClick={() => { setMemoryEditor(null); setModalError(""); }} aria-label="Close"><X size={15} /></button></header><label><span>Full memory chunk</span><textarea rows={14} value={memoryEditor.content} readOnly /></label><p className={styles.warning}>Hermes memory IDs are positional and its current API has no atomic compare-and-write operation. HERMESS keeps this view read-only to prevent a concurrent agent or dashboard change from modifying the wrong chunk.</p><footer><span /><button type="button" className={styles.secondary} onClick={() => { setMemoryEditor(null); setModalError(""); }}>Close</button></footer></div></div> : null}
    </div>
  );
}

export function SettingsView({ profileId }: { profileId: string }) {
  const [config, setConfig] = useState<ConfigValues>(defaultConfig);
  const [configBaseline, setConfigBaseline] = useState<ConfigValues>(defaultConfig);
  const [configRevision, setConfigRevision] = useState("");
  const [configReady, setConfigReady] = useState(false);
  const [credentials, setCredentials] = useState<CredentialProvider[]>([]);
  const [credentialsReady, setCredentialsReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [credentialError, setCredentialError] = useState("");
  const [showCredential, setShowCredential] = useState(false);
  const [credential, setCredential] = useState({ provider: "", label: "", api_key: "" });
  const closeCredentialModal = useCallback(() => {
    if (saving) return;
    setShowCredential(false);
    setCredentialError("");
    setCredential({ provider: "", label: "", api_key: "" });
  }, [saving]);
  useDialogGuard(showCredential, saving, closeCredentialModal);
  const configPatch = useMemo(() => Object.fromEntries(
    (Object.keys(config) as Array<keyof ConfigValues>)
      .filter((key) => config[key] !== configBaseline[key])
      .map((key) => [key, config[key]]),
  ) as Partial<ConfigValues>, [config, configBaseline]);
  const configDirty = Object.keys(configPatch).length > 0;

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    setCredentialError("");
    setShowCredential(false);
    setCredential({ provider: "", label: "", api_key: "" });
    setConfigReady(false);
    setConfigRevision("");
    setCredentialsReady(false);
    const [configResult, poolResult] = await Promise.allSettled([
      requestJson<{ values?: Partial<ConfigValues>; revision?: string }>(`/api/control/config?profile=${encodeURIComponent(profileId)}`),
      requestJson<{ providers?: CredentialProvider[] }>("/api/control/credentials"),
    ]);
    const failures: string[] = [];
    if (configResult.status === "fulfilled") {
      if (/^[a-f0-9]{64}$/.test(configResult.value.revision ?? "")) {
        const loaded = { ...defaultConfig, ...(configResult.value.values ?? {}) };
        setConfig(loaded);
        setConfigBaseline(loaded);
        setConfigRevision(configResult.value.revision ?? "");
        setConfigReady(true);
      } else failures.push("Hermes configuration did not include a revision.");
    } else {
      failures.push(configResult.reason instanceof Error ? configResult.reason.message : "Hermes configuration is unavailable.");
    }
    if (poolResult.status === "fulfilled") {
      setCredentials(Array.isArray(poolResult.value.providers) ? poolResult.value.providers : []);
      setCredentialsReady(true);
    } else {
      setCredentials([]);
      failures.push(poolResult.reason instanceof Error ? poolResult.reason.message : "Hermes credential pool is unavailable.");
    }
    setError(failures.join(" "));
    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configReady || !configRevision) {
      setError("Reload the live profile configuration before saving.");
      return;
    }
    if (!configDirty) {
      setNotice("No configuration changes to save.");
      return;
    }
    setSaving(true); setError(""); setNotice("");
    try {
      const saved = await requestJson<{ values?: Partial<ConfigValues>; revision?: string }>(`/api/control/config?profile=${encodeURIComponent(profileId)}`, { method: "PUT", body: JSON.stringify({ values: configPatch, expected_revision: configRevision }) });
      if (!saved.values || !/^[a-f0-9]{64}$/.test(saved.revision ?? "")) throw new Error("Hermes returned an invalid configuration revision.");
      const next = { ...defaultConfig, ...saved.values };
      setConfig(next);
      setConfigBaseline(next);
      setConfigRevision(saved.revision ?? "");
      setNotice("Configuration saved. New sessions will use the updated runtime policy.");
    } catch (cause) {
      setConfigReady(false);
      setConfigRevision("");
      setError(cause instanceof Error ? cause.message : "Configuration could not be saved.");
    }
    finally { setSaving(false); }
  };

  const addCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!credentialsReady || loading || saving) {
      setCredentialError("Reload the live global credential pool before storing a key.");
      return;
    }
    setSaving(true); setCredentialError(""); setNotice("");
    try {
      await requestJson("/api/control/credentials", { method: "POST", body: JSON.stringify(credential) });
      setCredential({ provider: "", label: "", api_key: "" });
      setShowCredential(false);
      await reload();
      setNotice("Credential stored by Hermes. The raw token was not returned to the browser.");
    } catch (cause) {
      setCredentialsReady(false);
      setCredentialError(cause instanceof Error ? cause.message : "Credential could not be stored.");
    }
    finally { setSaving(false); }
  };

  const setNumber = (key: keyof ConfigValues, value: string) => setConfig((current) => ({ ...current, [key]: Number(value) }));

  return <div className={styles.surface}>
    <header className={styles.hero}><div><span>Safe runtime controls</span><h1>Configuration & credentials</h1><p>Edit a curated Hermes policy surface. Secret values remain write-only and existing keys stay redacted.</p></div><button type="button" className={styles.secondary} onClick={() => void reload()} disabled={loading || saving}><RefreshCw size={14} /> Refresh</button></header>
    {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}
    {notice ? <div className={styles.notice}><Check size={14} /> {notice}</div> : null}
    {loading ? <LoadingState label="Loading redacted configuration…" /> : <div className={styles.settingsSplit}>
      {configReady ? <form className={styles.config} onSubmit={(event) => void save(event)}>
        <div className={styles.sectionTitle}><div><span>Profile · {profileId}</span><h2>Agent runtime</h2></div><ShieldCheck size={17} /></div>
        <div className={styles.fields}>
          <label><span>Reasoning effort</span><select value={config.reasoning_effort} onChange={(event) => setConfig((value) => ({ ...value, reasoning_effort: event.target.value }))}><option value="">Profile default</option><option value="none">None</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Maximum</option><option value="ultra">Ultra</option></select></label>
          <label><span>Service tier</span><select value={config.service_tier} onChange={(event) => setConfig((value) => ({ ...value, service_tier: event.target.value }))}><option value="">Profile default</option><option value="auto">Auto</option><option value="default">Default</option><option value="flex">Flex</option><option value="priority">Priority</option></select></label>
          <label><span>Maximum turns · up to 10,000</span><input type="number" min={1} max={10000} value={config.max_turns} onChange={(event) => setNumber("max_turns", event.target.value)} /></label>
          <label><span>Gateway timeout · seconds</span><input type="number" min={0} max={86400} value={config.gateway_timeout} onChange={(event) => setNumber("gateway_timeout", event.target.value)} /></label>
          <label><span>Live session limit · 0 unlimited</span><input type="number" min={0} max={1024} value={config.max_live_sessions} onChange={(event) => setNumber("max_live_sessions", event.target.value)} /></label>
          <label><span>Retention · days</span><input type="number" min={1} max={3650} value={config.sessions_retention_days} onChange={(event) => setNumber("sessions_retention_days", event.target.value)} /></label>
          <label><span>Compression threshold</span><input type="number" min={0.1} max={1} step={0.01} value={config.compression_threshold} onChange={(event) => setNumber("compression_threshold", event.target.value)} /></label>
          <label><span>Streaming mode</span><select value={config.streaming_transport} onChange={(event) => setConfig((value) => ({ ...value, streaming_transport: event.target.value }))}><option value="auto">Auto</option><option value="draft">Draft</option><option value="edit">Edit</option><option value="off">Off</option></select></label>
          <label><span>Log level</span><select value={config.logging_level} onChange={(event) => setConfig((value) => ({ ...value, logging_level: event.target.value }))}><option>DEBUG</option><option>INFO</option><option>WARNING</option><option>ERROR</option></select></label>
        </div>
        <div className={styles.toggles}><label aria-label="Context compression"><input aria-label="Context compression" type="checkbox" checked={config.compression_enabled} onChange={(event) => setConfig((value) => ({ ...value, compression_enabled: event.target.checked }))} /><span><strong>Context compression</strong><small>Compress long sessions near the configured threshold.</small></span></label><label aria-label="Response streaming"><input aria-label="Response streaming" type="checkbox" checked={config.streaming_enabled} onChange={(event) => setConfig((value) => ({ ...value, streaming_enabled: event.target.checked }))} /><span><strong>Response streaming</strong><small>Stream model output and tool progress to clients.</small></span></label><label aria-label="Unsafe automatic pruning"><input aria-label="Unsafe automatic pruning" type="checkbox" checked={config.sessions_auto_prune} disabled={!config.sessions_auto_prune} onChange={() => setConfig((value) => ({ ...value, sessions_auto_prune: false }))} /><span><strong>{config.sessions_auto_prune ? "Disable automatic pruning" : "Automatic pruning disabled"}</strong><small>{config.sessions_auto_prune ? "Turn this off to protect pinned and archived sessions." : "Use the revision-checked manual prune workflow instead."}</small></span></label></div>
        <footer className={styles.formActions}><span>Only changed, revision-checked fields are sent. Unsafe automatic prune is intentionally unavailable.</span><button className={styles.primary} type="submit" disabled={saving || !configDirty}>{saving ? <LoaderCircle className={styles.spin} size={14} /> : <Check size={14} />} Save policy</button></footer>
      </form> : <section className={styles.config}><EmptyState title="Live configuration unavailable" copy="Retry before editing; HERMESS will never submit fallback defaults." /></section>}
      <aside className={styles.credentials}>
        <div className={styles.sectionTitle}><div><span>Server-wide vault · all profiles</span><h2>Global credential pool</h2></div><button type="button" className={styles.primary} onClick={() => { setCredentialError(""); setShowCredential(true); }} disabled={!credentialsReady || loading || saving}><Plus size={13} /> Add</button></div>
        <div className={styles.secureBanner}><KeyRound size={16} /><p><strong>Secrets are global and write-only</strong><span>This pool is shared by every Hermes profile. HERMESS receives only redacted previews and metadata.</span></p></div>
        {credentialsReady ? credentials.flatMap((provider) => provider.entries.map((entry) => ({ ...entry, provider: provider.provider }))).map((entry) => <div className={styles.credential} key={`${entry.provider}-${entry.index}`}><span className={styles.emblem}><KeyRound size={14} /></span><span><strong>{entry.label || entry.provider}</strong><code>{entry.token_preview || "••••••••"}</code><small>{entry.auth_type || entry.source || `credential ${entry.index}`}</small></span><em className={styles.muted} title="Hermes exposes this credential by positional index; remove it in the official dashboard after reviewing the live pool.">Managed in dashboard</em></div>) : null}
        {credentialsReady && !credentials.some((provider) => provider.entries.length) ? <EmptyState title="No pooled credentials" copy="OpenAI Codex OAuth can remain in Hermes auth storage; API keys added here are redacted." /> : null}
        {!credentialsReady ? <EmptyState title="Credential pool unavailable" copy="Retry before adding or removing credentials." /> : null}
      </aside>
    </div>}
    {showCredential ? <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="credential-form-title"><button type="button" className={styles.scrim} onClick={closeCredentialModal} aria-label="Close credential form" disabled={saving} /><form className={styles.formCard} onSubmit={(event) => void addCredential(event)} aria-busy={saving}><header><div><span>Global write-only secret</span><h2 id="credential-form-title">Add API credential</h2></div><button type="button" onClick={closeCredentialModal} aria-label="Close credential form" disabled={saving}><X size={15} /></button></header><ModalError message={credentialError} /><label><span>Provider slug</span><input required pattern="[A-Za-z0-9](?:[A-Za-z0-9_.]|-)*" value={credential.provider} onChange={(event) => setCredential((value) => ({ ...value, provider: event.target.value }))} placeholder="openrouter" disabled={saving || loading || !credentialsReady} /></label><label><span>Label</span><input value={credential.label} onChange={(event) => setCredential((value) => ({ ...value, label: event.target.value }))} placeholder="Production key" disabled={saving || loading || !credentialsReady} /></label><label><span>API key</span><input required type="password" autoComplete="new-password" value={credential.api_key} onChange={(event) => setCredential((value) => ({ ...value, api_key: event.target.value }))} disabled={saving || loading || !credentialsReady} /></label><p className={styles.warning}>The key is sent once over this same-origin HTTPS connection, enters the global Hermes credential pool, and is never rendered back.</p><footer><button type="button" className={styles.secondary} onClick={closeCredentialModal} disabled={saving}>Cancel</button><button type="submit" className={styles.primary} disabled={saving || loading || !credentialsReady}>{saving ? <LoaderCircle className={styles.spin} size={13} /> : <KeyRound size={13} />} Store key</button></footer></form></div> : null}
  </div>;
}
