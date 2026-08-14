"use client";

import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Atom,
  Bell,
  Blocks,
  Bot,
  Box,
  Braces,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Clock3,
  Command,
  CornerDownLeft,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  Hexagon,
  History,
  Inbox,
  Library,
  Link2,
  ListFilter,
  LoaderCircle,
  Menu,
  MessageSquareText,
  MoonStar,
  Network,
  PanelLeftClose,
  Pause,
  PencilLine,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  TimerReset,
  Trash2,
  UserRound,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  initialMessages,
  profiles,
} from "@/lib/demo-data";
import {
  createHermesAutomation,
  createKnowledgeItem,
  deleteHermesAutomation,
  deleteHermesSession,
  discoverConnections,
  loadAutomations,
  loadHermesProfiles,
  loadHermesAutomationRuns,
  loadGraphActivation,
  loadHermesSkills,
  loadKnowledgeGraph,
  loadKnowledgeItem,
  loadKnowledgeItems,
  loadKnowledgeVault,
  loadSessionTranscript,
  loadSessions,
  loadSystemSnapshot,
  promoteKnowledgeItem,
  pruneHermesSessions,
  reindexKnowledge,
  saveKnowledgeItem,
  searchKnowledge,
  setHermesActiveProfile,
  setHermesAutomationEnabled,
  streamHermesChat,
  triggerHermesAutomation,
  updateHermesAutomation,
  updateHermesProfileModel,
  updateHermesSession,
} from "@/lib/api";
import { CapabilitiesView, SettingsView } from "@/components/hermes-capabilities";
import { AnalyticsView, RuntimeView } from "@/components/hermes-runtime";
import { BrainstreamView } from "@/components/brainstream-view";
import { SolariExperience } from "@/components/solari-experience";
import { SOLARI_SYSTEM_PROMPT } from "@/lib/solari";
import {
  KnowledgeGraphCanvas,
  type KnowledgeGraphCanvasHandle,
} from "@/components/knowledge-graph-canvas";
import { KnowledgeImportLauncher } from "@/components/knowledge-import";
import { KnowledgeDeleteButton } from "@/components/knowledge-delete";
import type { KnowledgeDeleteReceipt } from "@/components/knowledge-delete-contract";
import type {
  Automation,
  BrainTask,
  ChatMessage,
  GraphEdge,
  GraphNodeKind,
  KnowledgeGraph,
  KnowledgeItem,
  KnowledgeVault,
  Profile,
  Session,
  SessionTraceEntry,
  ServiceState,
  SystemSnapshot,
  TaskStatus,
  ToolTrace,
  ViewId,
} from "@/lib/types";

const initialSnapshot: SystemSnapshot = {
  hermes: "checking",
  knowledge: "checking",
  gateway: "checking",
  indexedNotes: 0,
  graphLinks: 0,
  activeSessions: 0,
  sessionsInPeriod: 0,
  tokensToday: 0,
  costToday: 0,
  analyticsPeriodDays: 7,
  analyticsLive: false,
  checkedAt: new Date(0),
};

type NavigationItem = {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  badge?: string;
};

const navigation: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: "Focus",
    items: [
      { id: "solari", label: "Solari", icon: Bot },
      { id: "overview", label: "Today", icon: Sparkles },
      { id: "chat", label: "Talk", icon: MessageSquareText },
      { id: "library", label: "Discover", icon: Library },
      { id: "graph", label: "Map", icon: Network },
    ],
  },
  {
    label: "Work",
    items: [
      { id: "sessions", label: "Threads", icon: History },
      { id: "tasks", label: "Tasks", icon: Blocks },
      { id: "automations", label: "Rhythms", icon: TimerReset },
    ],
  },
  {
    label: "System",
    items: [
      { id: "runtime", label: "Runtime", icon: Activity },
      { id: "analytics", label: "Analytics", icon: Atom },
      { id: "capabilities", label: "Capabilities", icon: Braces },
      { id: "settings", label: "Settings", icon: Settings2 },
    ],
  },
];

const viewLabels: Record<ViewId, { eyebrow: string; title: string }> = {
  solari: { eyebrow: "Creative intelligence", title: "Solari" },
  overview: { eyebrow: "Living brain", title: "Today" },
  chat: { eyebrow: "Think together", title: "Talk to Solari" },
  graph: { eyebrow: "Constellation", title: "Map" },
  library: { eyebrow: "Knowledge", title: "Discover" },
  sessions: { eyebrow: "History", title: "Threads" },
  automations: { eyebrow: "Creative rhythm", title: "Automations" },
  tasks: { eyebrow: "Workspace", title: "Tasks" },
  runtime: { eyebrow: "System", title: "Runtime & logs" },
  analytics: { eyebrow: "System", title: "Usage analytics" },
  capabilities: { eyebrow: "System", title: "Skills, MCP & memory" },
  settings: { eyebrow: "System", title: "Runtime policy & keys" },
  profiles: { eyebrow: "System", title: "Profiles & providers" },
};

const kindMeta: Record<GraphNodeKind, { label: string; color: string; icon: LucideIcon }> = {
  note: { label: "Note", color: "var(--mint)", icon: FileText },
  memory: { label: "Memory", color: "var(--violet)", icon: BrainCircuit },
  skill: { label: "Skill", color: "var(--amber)", icon: Braces },
  insight: { label: "Insight", color: "var(--blue)", icon: Sparkles },
  task: { label: "Task", color: "var(--rose)", icon: CheckCircle2 },
};

const taskColumns: Array<{ id: TaskStatus; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "active", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

function compactNumber(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function isBrainTask(value: unknown): value is BrainTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string"
    && typeof task.title === "string"
    && typeof task.detail === "string"
    && ["backlog", "active", "review", "done"].includes(String(task.status))
    && ["low", "medium", "high"].includes(String(task.priority))
    && Array.isArray(task.tags)
    && task.tags.every((tag) => typeof tag === "string")
    && (task.agent === undefined || typeof task.agent === "string");
}

function formatClock(date: Date) {
  if (!date.getTime()) return "waiting for first check";
  return `checked ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function useDialogGuard(open: boolean, dismiss: () => void, locked = false) {
  const options = useRef({ dismiss, locked });
  useEffect(() => { options.current = { dismiss, locked }; }, [dismiss, locked]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].at(-1);
    if (!dialog) return;
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.classList.contains("dismiss-layer"));
    const inerted: Array<{ element: HTMLElement; inert: boolean }> = [];
    let branch: HTMLElement | null = dialog;
    while (branch?.parentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const sibling of [...parent.children]) {
        if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
        inerted.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      branch = parent;
      if (branch === document.body) break;
    }
    const timer = window.setTimeout(() => {
      const first = focusables()[0];
      if (first) first.focus();
      else { dialog.tabIndex = -1; dialog.focus(); }
    }, 0);
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !options.current.locked) {
        event.preventDefault();
        options.current.dismiss();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusables();
      if (!candidates.length) { event.preventDefault(); dialog.focus(); return; }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", listener);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", listener);
      inerted.forEach(({ element, inert }) => { element.inert = inert; });
      previous?.focus();
    };
  }, [open]);
}

function mergeGraphEdges(graph: KnowledgeGraph, additions: GraphEdge[]): KnowledgeGraph {
  const knownNodes = new Set(graph.nodes.map((node) => node.id));
  const byKey = new Map<string, GraphEdge>();
  for (const edge of [...graph.edges, ...additions]) {
    if (!knownNodes.has(edge.source) || !knownNodes.has(edge.target) || edge.source === edge.target) continue;
    const pair = [edge.source, edge.target].sort().join("\u0000");
    const key = `${pair}\u0000${edge.kind ?? edge.relation}`;
    const previous = byKey.get(key);
    if (!previous || edge.weight > previous.weight) byKey.set(key, edge);
  }
  return { ...graph, edges: [...byKey.values()] };
}

function StatusDot({ state, pulse = false }: { state: ServiceState; pulse?: boolean }) {
  return (
    <span
      className={classNames("status-dot", `is-${state}`, pulse && state === "online" && "is-pulsing")}
      aria-label={state}
    />
  );
}

function MiniLogo() {
  return (
    <span className="mini-logo" aria-hidden="true">
      <span className="mini-logo-ring" />
      <span className="mini-logo-core" />
    </span>
  );
}

function SurfaceHeader({
  eyebrow,
  title,
  copy,
  actions,
}: {
  eyebrow: string;
  title: string;
  copy?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="surface-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {copy ? <p className="surface-copy">{copy}</p> : null}
      </div>
      {actions ? <div className="surface-actions">{actions}</div> : null}
    </div>
  );
}

function ServiceBadge({ label, state }: { label: string; state: ServiceState }) {
  return (
    <span className="service-badge">
      <StatusDot state={state} pulse />
      <span>{label}</span>
      <span className="service-badge-state">{state}</span>
    </span>
  );
}

function EmptyState({ icon: Icon, title, copy }: { icon: LucideIcon; title: string; copy: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={20} /></span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolTrace }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={classNames("tool-card", `is-${tool.status}`)}>
      <button onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="tool-status-icon">
          {tool.status === "running" ? <LoaderCircle className="spin" size={14} /> : tool.status === "error" ? <X size={14} /> : <Check size={14} />}
        </span>
        <span><small>Tool call</small><strong>{tool.name}</strong></span>
        {tool.elapsed ? <em>{tool.elapsed}</em> : null}
        <ChevronDown size={14} className={expanded ? "rotate" : ""} />
      </button>
      {expanded ? (
        <div className="tool-detail">
          {tool.input ? <div><span>Input</span><code>{tool.input}</code></div> : null}
          {tool.output ? <div><span>Result</span><code>{tool.output}</code></div> : null}
        </div>
      ) : null}
    </div>
  );
}

function ChatView({ profile, options, onProfile, snapshot }: { profile: Profile; options: Profile[]; onProfile: (profile: Profile) => void; snapshot: SystemSnapshot }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const toolCalls = messages.reduce((total, message) => total + (message.tools?.length ?? 0), 0);
  const liveTurns = messages.filter((message) => message.id !== "welcome").length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = () => abortRef.current?.abort();
  const clearConversation = () => {
    abortRef.current?.abort();
    setMessages(initialMessages);
    setError("");
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || streaming) return;
    setDraft("");
    setError("");
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: "Now" };
    const assistantId = crypto.randomUUID();
    const history = [...messages, userMessage];
    setMessages([...history, { id: assistantId, role: "assistant", content: "", createdAt: "Now", streaming: true }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamHermesChat(
        [
          { role: "system", content: SOLARI_SYSTEM_PROMPT },
          ...history.filter((message) => message.id !== "welcome").map(({ role, content: messageContent }) => ({ role, content: messageContent })),
        ],
        profile.id,
        profile.provider,
        profile.model,
        {
          onText: (text) => setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: message.content + text } : message)),
          onTool: (tool) => setMessages((current) => current.map((message) => {
            if (message.id !== assistantId) return message;
            const existing = message.tools ?? [];
            return { ...message, tools: [...existing.filter((item) => item.id !== tool.id), tool] };
          })),
        },
        controller.signal,
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        const detail = cause instanceof Error ? cause.message : "Solari could not complete this turn.";
        setError(detail);
        setMessages((current) => current.map((message) => message.id === assistantId && !message.content ? {
          ...message,
          content: "I couldn’t reach my Hermes runtime. Check the provider credentials and gateway health, then try again.",
        } : message));
      }
    } finally {
      setStreaming(false);
      setMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, content: message.content || (controller.signal.aborted ? "Generation stopped." : "Solari returned no text."), streaming: false }
        : message));
      abortRef.current = null;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="surface chat-surface">
      <div className="chat-main">
        <div className="chat-topline">
          <div className="agent-identity"><span className="agent-avatar"><MiniLogo /></span><div><strong>Solari</strong><span><StatusDot state={snapshot.hermes} pulse /> Hermes {snapshot.hermes} · {profile.model}</span></div></div>
          <div className="chat-actions">
            <label className="chat-inline-profile">
              <span>Profile</span>
              <select value={profile.id} onChange={(event) => onProfile(options.find((item) => item.id === event.target.value) ?? options[0])} aria-label="Request model profile">
                {options.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.provider}</option>)}
              </select>
            </label>
            <button className="icon-button" title="Clear conversation" aria-label="Clear conversation" onClick={clearConversation}><Trash2 size={15} /></button>
          </div>
        </div>
        <div className="message-stream" aria-live="polite">
          <div className="conversation-date"><span>Today</span></div>
          {messages.map((message) => (
            <article key={message.id} className={classNames("message-row", `is-${message.role}`)}>
              <span className="message-avatar">{message.role === "assistant" ? <MiniLogo /> : <UserRound size={15} />}</span>
              <div className="message-body">
                <div className="message-meta"><strong>{message.role === "assistant" ? "Solari" : "You"}</strong><span>{message.createdAt}</span></div>
                {message.content ? <p>{message.content}</p> : message.streaming ? <span className="thinking-dots" aria-label="Solari is thinking"><i /><i /><i /></span> : <p className="muted-copy">No response content.</p>}
                {message.tools?.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
              </div>
            </article>
          ))}
          <div ref={endRef} />
        </div>
        <div className="composer-wrap">
          {error ? <div className="inline-alert"><ShieldCheck size={14} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={13} /></button></div> : null}
          <div className="composer">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} placeholder="Ask, build, remix, or remember…" rows={1} aria-label="Message Solari" />
            <div className="composer-footer">
              <div><span className="composer-context"><BrainCircuit size={14} /> Solari persona · Hermes-managed context</span></div>
              {streaming ? (
                <button className="send-button is-stop" onClick={stop} aria-label="Stop generating"><Square size={13} fill="currentColor" /></button>
              ) : (
                <button className="send-button" onClick={() => void send()} disabled={!draft.trim()} aria-label="Send message"><Send size={15} /></button>
              )}
            </div>
          </div>
          <p className="composer-hint"><Command size={11} /> Enter to send · Shift + Enter for a new line</p>
        </div>
      </div>
      <aside className="chat-context">
        <div className="context-section">
          <div className="context-heading"><span>Request profile</span><small>Per new turn</small></div>
          <label className="profile-select">
            <span className={`profile-mark ${profile.accent}`}><Braces size={15} /></span>
            <select value={profile.id} onChange={(event) => onProfile(options.find((item) => item.id === event.target.value) ?? options[0])} aria-label="Request model profile">
              {options.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.provider}</option>)}
            </select>
            <ChevronDown size={14} />
          </label>
          <p>{profile.description}</p>
        </div>
        <div className="context-section"><div className="context-heading"><span>Knowledge context</span><small>Automatic</small></div><p>Hermes assembles memory, skills, and session context server-side for each request. No fabricated attachment list is shown here.</p></div>
        <div className="context-section context-usage"><div className="context-heading"><span>Context window</span><small>Model-managed</small></div><p>Compression and limits follow the active profile configuration.</p></div>
        <div className="context-section">
          <div className="context-heading"><span>Client trace</span><StatusDot state={streaming ? "online" : snapshot.gateway} pulse={streaming} /></div>
          <div className="trace-timeline"><span><Check size={11} /></span><p><strong>{liveTurns} live message{liveTurns === 1 ? "" : "s"}</strong><small>Welcome text is never sent as history</small></p></div>
          <div className="trace-timeline"><span><Radio size={11} /></span><p><strong>{streaming ? "Solari is transmitting" : "Ready for a prompt"}</strong><small>{toolCalls} Hermes tool event{toolCalls === 1 ? "" : "s"} observed</small></p></div>
        </div>
      </aside>
    </div>
  );
}

function GraphView({ graph, live, onReload, onDiscovered }: { graph: KnowledgeGraph; live: boolean; onReload: () => void | Promise<void>; onDiscovered: (edges: GraphEdge[]) => void }) {
  const canvasRef = useRef<KnowledgeGraphCanvasHandle>(null);
  const [selected, setSelected] = useState<string | null>(graph.nodes[0]?.id ?? null);
  const [filters, setFilters] = useState<Set<GraphNodeKind>>(new Set(["note", "memory", "skill", "insight", "task"]));
  const [discovering, setDiscovering] = useState(false);
  const [discoveryNotice, setDiscoveryNotice] = useState("");
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [activation, setActivation] = useState<Map<string, number>>(new Map());
  const canvasSelection = selected && graph.nodes.some((node) => node.id === selected)
    ? selected
    : selected
      ? graph.nodes[0]?.id ?? null
      : null;
  const selectedNode = canvasSelection ? graph.nodes.find((node) => node.id === canvasSelection) : undefined;
  const visibleNodes = useMemo(() => new Map(graph.nodes.filter((node) => filters.has(node.kind)).map((node) => [node.id, node])), [filters, graph.nodes]);
  const neighborResult = useMemo(() => {
    if (!selectedNode) return { edges: [] as GraphEdge[], total: 0 };
    const strongest = new Map<string, GraphEdge>();
    for (const edge of graph.edges) {
      if (edge.source !== selectedNode.id && edge.target !== selectedNode.id) continue;
      const neighborId = edge.source === selectedNode.id ? edge.target : edge.source;
      if (!visibleNodes.has(neighborId)) continue;
      const current = strongest.get(neighborId);
      const score = activation.get(neighborId) ?? edge.weight;
      const currentScore = current ? activation.get(neighborId) ?? current.weight : -1;
      if (!current || score > currentScore) strongest.set(neighborId, edge);
    }
    const ranked = [...strongest.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const score = (activation.get(rightId) ?? right.weight) - (activation.get(leftId) ?? left.weight);
        return score || leftId.localeCompare(rightId);
      })
      .map(([, edge]) => edge);
    return { edges: ranked.slice(0, 40), total: ranked.length };
  }, [activation, graph.edges, selectedNode, visibleNodes]);
  const neighbors = neighborResult.edges;

  useEffect(() => {
    let cancelled = false;
    if (!live || !canvasSelection) return () => { cancelled = true; };
    void loadGraphActivation(canvasSelection)
      .then((scores) => { if (!cancelled) setActivation(scores); })
      .catch(() => { if (!cancelled) setActivation(new Map()); });
    return () => { cancelled = true; };
  }, [canvasSelection, live]);

  useEffect(() => {
    const clear = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, []);

  const toggleFilter = (kind: GraphNodeKind) => {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(kind)) {
        if (next.size > 1) {
          next.delete(kind);
          if (selectedNode?.kind === kind) setSelected(null);
        }
      } else next.add(kind);
      return next;
    });
  };

  const discover = async () => {
    if (!live) return;
    setDiscovering(true);
    setDiscoveryNotice("");
    try {
      const edges = await discoverConnections(selectedNode?.id);
      onDiscovered(edges);
      setDiscoveryNotice(`${edges.length} semantic suggestion${edges.length === 1 ? "" : "s"} added to this view.`);
      setLayoutRevision((value) => value + 1);
      canvasRef.current?.reheat();
    } catch (cause) {
      setDiscoveryNotice(cause instanceof Error ? cause.message : "Connection discovery failed.");
    } finally {
      setDiscovering(false);
    }
  };

  const reload = async () => {
    await onReload();
    setLayoutRevision((value) => value + 1);
  };

  return (
    <div className="surface graph-surface">
      <SurfaceHeader eyebrow="Private living map" title="Your knowledge graph" copy="Only your vault notes and imported documents—connected by links, tags, and meaning." actions={<><span className={classNames("source-pill", live && "is-live")}><Radio size={11} /> {live ? "Personal vault only" : "Graph unavailable"}</span><button className="button button-primary" onClick={discover} disabled={!live || discovering} title={!live ? "Reconnect the knowledge index to discover links" : undefined}>{discovering ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />} Discover links</button></>} />
      {discoveryNotice ? <div className="inline-alert surface-alert"><Network size={14} /><span>{discoveryNotice}</span><button onClick={() => setDiscoveryNotice("")} aria-label="Dismiss discovery result"><X size={13} /></button></div> : null}
      <div className="graph-toolbar">
        <div className="graph-filters">
          {Object.entries(kindMeta).map(([kind, meta]) => (
            <button key={kind} onClick={() => toggleFilter(kind as GraphNodeKind)} className={filters.has(kind as GraphNodeKind) ? "is-active" : ""}><span style={{ background: meta.color }} />{meta.label}<small>{graph.nodes.filter((node) => node.kind === kind).length}</small></button>
          ))}
        </div>
        <div className="graph-actions"><button className="icon-button" title="Fit graph" aria-label="Fit graph" onClick={() => canvasRef.current?.fit()}><CircleGauge size={15} /></button><button className="icon-button" onClick={() => void reload()} title="Reload graph" aria-label="Reload graph"><RefreshCw size={15} /></button></div>
      </div>
      <div className="graph-layout">
        <KnowledgeGraphCanvas ref={canvasRef} graph={graph} selected={canvasSelection} onSelect={setSelected} onClearSelection={() => setSelected(null)} filters={filters} layoutRevision={layoutRevision} />
        <aside className="node-inspector">
          {selectedNode ? (
            <>
              <div className="node-inspector-top"><span className="kind-icon" style={{ color: kindMeta[selectedNode.kind].color, background: `color-mix(in srgb, ${kindMeta[selectedNode.kind].color} 10%, transparent)` }}>{(() => { const Icon = kindMeta[selectedNode.kind].icon; return <Icon size={17} />; })()}</span></div>
              <span className="node-kind">{kindMeta[selectedNode.kind].label} · {activation.has(selectedNode.id) ? `${Math.round((activation.get(selectedNode.id) ?? 0) * 100)}% activation` : `${Math.round(selectedNode.weight * 100)}% graph strength`}</span>
              <h2>{selectedNode.title}</h2>
              <p>{selectedNode.summary}</p>
              <div className="tag-row">{selectedNode.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
              <div className="inspector-divider" />
              <div className="inspector-label"><span>Connected to</span><small>{neighborResult.total}{neighborResult.total > neighbors.length ? ` · top ${neighbors.length}` : ""}</small></div>
              <div className="neighbor-list">
                {neighbors.length ? neighbors.map((edge) => {
                  const id = edge.source === selectedNode.id ? edge.target : edge.source;
                  const node = graph.nodes.find((item) => item.id === id);
                  if (!node) return null;
                  const strength = activation.get(node.id) ?? edge.weight;
                  return <button key={`${edge.source}-${edge.target}`} onClick={() => setSelected(node.id)}><span style={{ background: kindMeta[node.kind].color }} /><span><strong>{node.title}</strong><small>{edge.relation} · {Math.round(strength * 100)}% {activation.has(node.id) ? "activation" : "edge strength"}</small></span><ChevronRight size={13} /></button>;
                }) : <p className="muted-copy">No visible neighbors with these filters.</p>}
              </div>
            </>
          ) : <EmptyState icon={Network} title="Select a node" copy="Its context and strongest neighbors will appear here." />}
        </aside>
      </div>
    </div>
  );
}

function LibraryView({
  items,
  graph,
  live,
  onItems,
  focusId,
  onFocusConsumed,
  vault,
  onImported,
  onTrashed,
  onOpenKnowledge,
}: {
  items: KnowledgeItem[];
  graph: KnowledgeGraph;
  live: boolean;
  onItems: (items: KnowledgeItem[]) => void;
  focusId?: string;
  onFocusConsumed?: () => void;
  vault: KnowledgeVault | null;
  onImported: () => void | Promise<void>;
  onTrashed: (receipt: KnowledgeDeleteReceipt) => void | Promise<void>;
  onOpenKnowledge: (id: string) => void;
}) {
  const [scope, setScope] = useState<"all" | GraphNodeKind>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "title" | "strength">("recent");
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [draft, setDraft] = useState<KnowledgeItem | null>(null);
  const [mutationError, setMutationError] = useState("");
  const [copied, setCopied] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const filtered = useMemo(() => items
    .filter((item) => (scope === "all" || item.kind === scope) && `${item.title} ${item.summary} ${item.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => sort === "title"
      ? left.title.localeCompare(right.title)
      : sort === "strength"
        ? right.weight - left.weight || left.title.localeCompare(right.title)
        : String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) || left.title.localeCompare(right.title)), [items, query, scope, sort]);
  const activeItem = editing && draft ? draft : selected;

  useEffect(() => {
    if (!focusId) return;
    const item = items.find((candidate) => candidate.id === focusId);
    if (!item) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setSelectedId(item.id);
      setMobileDetail(true);
      setEditing(false);
      setCreating(false);
      if (!live || item.detailLoaded) { onFocusConsumed?.(); return; }
      void loadKnowledgeItem(item.id).then((detail) => {
        if (!cancelled && detail) onItems(items.map((current) => current.id === detail.id ? detail : current));
      }).catch(() => undefined).finally(() => { if (!cancelled) onFocusConsumed?.(); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [focusId, items, live, onFocusConsumed, onItems]);

  const chooseItem = async (item: KnowledgeItem) => {
    setSelectedId(item.id);
    setMobileDetail(true);
    setEditing(false);
    setCreating(false);
    setDraft(null);
    if (!live) return;
    try {
      const detail = await loadKnowledgeItem(item.id);
      if (detail) onItems(items.map((current) => current.id === detail.id ? detail : current));
    } catch {
      // The summary remains readable if the detail endpoint is temporarily unavailable.
    }
  };

  const createNote = async () => {
    setMutationError("");
    if (!live) {
      setMutationError("The knowledge vault is unavailable. Reconnect before creating a note.");
      return;
    }
    const draftNote: KnowledgeItem = {
      id: crypto.randomUUID(),
      title: "Untitled note",
      kind: "note",
      summary: "",
      content: "",
      tags: [],
      weight: 0,
      updatedAt: "Just now",
      status: "seed",
      detailLoaded: true,
      editable: true,
    };
    setSelectedId(draftNote.id);
    setMobileDetail(true);
    setDraft(draftNote);
    setCreating(true);
    setEditing(true);
  };

  const save = async () => {
    if (!draft) return;
    if (!live) {
      setMutationError("The knowledge vault is unavailable. Your draft has not been written.");
      return;
    }
    setSaving(true);
    setMutationError("");
    let saved: KnowledgeItem;
    try {
      saved = creating
        ? await createKnowledgeItem({ title: draft.title, content: draft.content, tags: draft.tags, kind: draft.kind, idempotencyKey: draft.id })
        : await saveKnowledgeItem(draft);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "The note could not be saved.");
      setSaving(false);
      return;
    }
    onItems(creating ? [saved, ...items] : items.map((item) => item.id === draft.id ? saved : item));
    setSelectedId(saved.id);
    setSaving(false);
    setEditing(false);
    setCreating(false);
    setDraft(null);
  };

  const cancelEdit = () => {
    setDraft(selected ?? null);
    setEditing(false);
    setCreating(false);
  };

  const beginEdit = async () => {
    if (!selected) return;
    if (!live) {
      setMutationError("The knowledge vault is unavailable. Editing is disabled to prevent lost work.");
      return;
    }
    setMutationError("");
    let editable = selected;
    if (live && !selected.detailLoaded) {
      setLoadingDetail(true);
      try {
        const detail = await loadKnowledgeItem(selected.id);
        if (!detail) throw new Error("Knowledge returned no note detail.");
        editable = detail;
        onItems(items.map((item) => item.id === detail.id ? detail : item));
      } catch (cause) {
        setMutationError(cause instanceof Error ? cause.message : "The full note could not be loaded.");
        setLoadingDetail(false);
        return;
      }
      setLoadingDetail(false);
    }
    setDraft(editable);
    setCreating(false);
    setEditing(true);
  };

  const promote = async () => {
    if (!selected) return;
    if (!live) {
      setMutationError("The knowledge vault is unavailable. Reconnect before promoting this note.");
      return;
    }
    setMutationError("");
    let promoted: KnowledgeItem;
    try {
      promoted = await promoteKnowledgeItem(selected.id, selected.revision);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "The note could not be promoted.");
      return;
    }
    onItems(items.map((item) => item.id === selected.id ? promoted : item));
  };

  return (
    <div className="surface library-surface">
      <SurfaceHeader eyebrow="Obsidian-compatible" title="Knowledge vault" copy="Add files, create Markdown, and browse your vault alongside read-only Hermes reference sources." actions={<><span className={classNames("source-pill", live && "is-live")}><Database size={11} /> {live ? `${vault?.name ?? "Local"} vault` : "Vault unavailable"}</span>{vault?.openUri ? <a className="button button-quiet" href={vault.openUri}><ExternalLink size={14} /> Open Obsidian</a> : null}<KnowledgeImportLauncher live={live} vaultName={vault?.name} onImported={onImported} onOpenKnowledge={onOpenKnowledge} /><button className="button button-primary" onClick={() => void createNote()} disabled={!live} title={!live ? "Reconnect the knowledge vault to create an item" : undefined}><Plus size={15} /> New item</button></>} />
      {!live ? <div className="inline-alert surface-alert"><ShieldCheck size={14} /><span>The knowledge service is unavailable. This view is read-only; no local-only edits will be accepted.</span></div> : null}
      {mutationError ? <div className="inline-alert surface-alert"><ShieldCheck size={14} /><span>{mutationError}</span><button onClick={() => setMutationError("")} aria-label="Dismiss"><X size={13} /></button></div> : null}
      <div className="library-tabs">
        {(["all", "note", "memory", "skill", "insight", "task"] as const).map((kind) => <button key={kind} className={scope === kind ? "is-active" : ""} onClick={() => setScope(kind)}>{kind === "all" ? "All knowledge" : `${kindMeta[kind].label}s`}<span>{kind === "all" ? items.length : items.filter((item) => item.kind === kind).length}</span></button>)}
      </div>
      <div className={classNames("library-layout", mobileDetail && "is-mobile-detail")}>
        <div className="library-list-pane">
          <label className="field-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter this collection…" aria-label="Filter knowledge collection" /><span className="field-search-scope">This view</span></label>
          <div className="library-sort"><span>{filtered.length} items</span><label><ListFilter size={13} /><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Sort knowledge"><option value="recent">Recently updated</option><option value="title">Title A–Z</option><option value="strength">Graph strength</option></select></label></div>
          <div className="knowledge-list">
            {filtered.map((item) => {
              const Icon = kindMeta[item.kind].icon;
              return <button key={item.id} onClick={() => void chooseItem(item)} className={selected?.id === item.id ? "is-selected" : ""}><span className="knowledge-kind-icon" style={{ color: kindMeta[item.kind].color }}><Icon size={16} /></span><span className="knowledge-list-copy"><strong>{item.title}</strong><small>{item.summary}</small><span><em>{kindMeta[item.kind].label}</em>{item.tags.slice(0, 2).map((tag) => <i key={tag}>#{tag}</i>)}<time>{item.updatedAt}</time></span></span><ChevronRight size={14} /></button>;
            })}
            {!filtered.length ? <EmptyState icon={Search} title="Nothing found" copy="Try a broader term or another collection." /> : null}
          </div>
        </div>
        <article className="knowledge-reader">
          {activeItem ? (() => {
            const activeDraft = activeItem;
            const canEdit = activeDraft.editable === true;
            const noteReference = activeDraft.path
              ? `[[${activeDraft.path.replace(/\.md$/i, "")}|${activeDraft.title}]]`
              : `[[${activeDraft.title}]]`;
            return (
            <>
              <div className="reader-toolbar">
                <div><button className="library-mobile-back" onClick={() => setMobileDetail(false)} aria-label="Back to knowledge list"><ArrowLeft size={14} /> List</button><span className="source-pill"><span style={{ background: kindMeta[activeDraft.kind].color }} />{kindMeta[activeDraft.kind].label}</span><span className={`maturity-pill is-${activeDraft.status}`}>{creating ? "draft" : activeDraft.status}</span></div>
                <div>{editing ? <><button className="button button-quiet" onClick={cancelEdit}>Cancel</button><button className="button button-primary" onClick={() => void save()} disabled={saving || !live || !activeDraft.title.trim()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {creating ? "Create" : "Save"}</button></> : <>{activeDraft.obsidianUri ? <a className="icon-button" title="Open this note in Obsidian" aria-label="Open this note in Obsidian" href={activeDraft.obsidianUri}><ExternalLink size={15} /></a> : null}<button className="icon-button" title="Copy path-qualified wiki link" aria-label="Copy note reference" onClick={() => { void navigator.clipboard.writeText(noteReference).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }).catch(() => setMutationError("Clipboard access was denied. Copy the vault path shown below instead.")); }}>{copied ? <Check size={15} /> : <Link2 size={15} />}</button><KnowledgeDeleteButton target={activeDraft} live={live} onConflictRefresh={onImported} onDeleted={async (receipt) => { setSelectedId(""); setDraft(null); setEditing(false); setCreating(false); setMobileDetail(false); await onTrashed(receipt); }} /><button className="button button-quiet" onClick={() => void beginEdit()} disabled={loadingDetail || !live || !canEdit} title={!live ? "Reconnect the knowledge vault to edit" : !canEdit ? "This Hermes source is mounted read-only" : undefined}>{loadingDetail ? <LoaderCircle className="spin" size={14} /> : <PencilLine size={14} />} Edit</button></>}</div>
              </div>
              {editing ? (
                <div className="note-editor">
                  {creating ? <label><span>Knowledge type</span><select value={activeDraft.kind} onChange={(event) => setDraft({ ...activeDraft, kind: event.target.value as GraphNodeKind })}>{Object.entries(kindMeta).map(([kind, meta]) => <option key={kind} value={kind}>{meta.label}</option>)}</select></label> : null}
                  <label><span>Title</span><input value={activeDraft.title} onChange={(event) => setDraft({ ...activeDraft, title: event.target.value })} /></label>
                  <label><span>Markdown</span><textarea value={activeDraft.content} onChange={(event) => setDraft({ ...activeDraft, content: event.target.value })} rows={15} /></label>
                </div>
              ) : (
                <>
                  <div className="reader-title"><p className="eyebrow">{activeDraft.status === "permanent" ? "Permanent note" : activeDraft.editable ? "Vault note" : `Read-only ${activeDraft.source ?? "Hermes source"}`}</p><h2>{activeDraft.title}</h2><p>{activeDraft.summary}</p></div>
                  <div className="reader-meta"><span><Clock3 size={13} /> Updated {activeDraft.updatedAt || "unknown"}</span><span><Link2 size={13} /> {graph.edges.filter((edge) => edge.source === activeDraft.id || edge.target === activeDraft.id).length} graph links</span><span><Activity size={13} /> {Math.round(activeDraft.weight * 100)}% graph strength</span>{activeDraft.path ? <span title={activeDraft.path}><FileText size={13} /> {activeDraft.path}</span> : null}</div>
                  <div className="reader-content"><pre className="reader-markdown">{activeDraft.content}</pre></div>
                  <div className="reader-tags">{activeDraft.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
                  {activeDraft.kind === "note" && activeDraft.editable === true && activeDraft.status !== "permanent" ? <div className="graduation-card"><span><Sparkles size={17} /></span><div><strong>Ready to become permanent?</strong><p>Graduation preserves the claim and makes it eligible for durable retrieval.</p></div><button className="button button-quiet" onClick={() => void promote()} disabled={!live}>Promote</button></div> : null}
                </>
              )}
            </>
            );
          })() : <EmptyState icon={Library} title="Choose an item" copy="Select a note, memory, or skill to inspect it." />}
        </article>
      </div>
    </div>
  );
}

function SessionsView({ sessions, live, onSessions, profileId, onNew }: { sessions: Session[]; live: boolean; onSessions: (sessions: Session[]) => void; profileId: string; onNew: () => void }) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [archived, setArchived] = useState<"exclude" | "include" | "only">("exclude");
  const [selectedId, setSelectedId] = useState(sessions[0]?.id ?? "");
  const [transcript, setTranscript] = useState<SessionTraceEntry[]>([]);
  const [transcriptFor, setTranscriptFor] = useState("");
  const [transcriptError, setTranscriptError] = useState("");
  const [transcriptReload, setTranscriptReload] = useState(0);
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPrune, setShowPrune] = useState(false);
  const [pruneDays, setPruneDays] = useState(90);
  const [pruneMatch, setPruneMatch] = useState<number | null>(null);
  const [pruneCandidates, setPruneCandidates] = useState(0);
  const [pruneProtected, setPruneProtected] = useState(0);
  const [pruneTooMany, setPruneTooMany] = useState(false);
  const [pruneToken, setPruneToken] = useState("");
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  const filteredSessions = live ? sessions : sessions.filter((session) => `${session.title} ${session.preview} ${session.model}`.toLowerCase().includes(query.toLowerCase()));
  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0];
  const sources = sourceOptions;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSourceOptions((current) => [...new Set([...current, ...sessions.map((session) => session.source).filter((item): item is string => Boolean(item))])].sort());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessions]);

  useDialogGuard(showPrune, () => setShowPrune(false), busy);

  useEffect(() => {
    let cancelled = false;
    if (!live || !selected?.id) {
      return () => { cancelled = true; };
    }
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setTranscriptError("");
      void loadSessionTranscript(selected.id, profileId)
        .then((entries) => { if (!cancelled) { setTranscript(entries); setTranscriptFor(selected.id); } })
        .catch((cause) => { if (!cancelled) { setTranscript([]); setTranscriptFor(selected.id); setTranscriptError(cause instanceof Error ? cause.message : "Transcript could not be loaded."); } });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [live, profileId, selected?.id, transcriptReload]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadSessions(query, { source, archived, profile: profileId }).then((result) => {
        if (!cancelled && result.live) onSessions(result.items);
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [archived, live, onSessions, profileId, query, source]);

  const archiveSelected = async () => {
    if (!selected || !live) return;
    setBusy(true); setMutationError("");
    try {
      const nextArchived = !selected.archived;
      await updateHermesSession(selected.id, { archived: nextArchived, profile: profileId });
      if ((archived === "exclude" && nextArchived) || (archived === "only" && !nextArchived)) {
        onSessions(sessions.filter((item) => item.id !== selected.id));
        setSelectedId("");
      } else {
        onSessions(sessions.map((item) => item.id === selected.id ? { ...item, archived: nextArchived } : item));
      }
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : "Session archive failed."); }
    finally { setBusy(false); }
  };

  const removeSelected = async () => {
    if (!selected || !live || !window.confirm(`Permanently delete “${selected.title}”?`)) return;
    setBusy(true); setMutationError("");
    try { await deleteHermesSession(selected.id, profileId); onSessions(sessions.filter((item) => item.id !== selected.id)); setSelectedId(""); }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : "Session delete failed."); }
    finally { setBusy(false); }
  };

  const previewPrune = async () => {
    setBusy(true); setMutationError("");
    try {
      const result = await pruneHermesSessions({ olderThanDays: pruneDays, source, dryRun: true, profile: profileId });
      setPruneMatch(result.matched ?? 0);
      setPruneCandidates(result.candidate_count ?? result.matched ?? 0);
      setPruneProtected((result.protected_pinned ?? 0) + (result.protected_archived ?? 0) + (result.protected_active ?? 0) + (result.protected_unverified ?? 0));
      setPruneTooMany(result.too_many === true);
      setPruneToken(result.preview_token ?? "");
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : "Prune preview failed."); }
    finally { setBusy(false); }
  };

  const executePrune = async () => {
    if (pruneMatch == null || pruneTooMany || !pruneToken || !window.confirm(`Delete ${pruneMatch} verified ended session${pruneMatch === 1 ? "" : "s"}?`)) return;
    setBusy(true); setMutationError("");
    try {
      const removed = await pruneHermesSessions({ olderThanDays: pruneDays, source, dryRun: false, profile: profileId, previewToken: pruneToken });
      if ((removed.failed ?? 0) > 0) throw new Error(`${removed.failed} session deletion${removed.failed === 1 ? "" : "s"} could not be completed.`);
      const result = await loadSessions(query, { source, archived, profile: profileId });
      onSessions(result.items); setShowPrune(false); setPruneMatch(null);
    } catch (cause) { setPruneToken(""); setPruneMatch(null); setMutationError(cause instanceof Error ? cause.message : "Session prune failed."); }
    finally { setBusy(false); }
  };

  return (
    <div className="surface sessions-surface">
      <SurfaceHeader eyebrow="Persistent history" title="Sessions" copy="Search the full store, inspect tool traces, export records, and apply safe retention controls." actions={<><span className={classNames("source-pill", live && "is-live")}><Radio size={11} /> {live ? "Hermes state" : "Preview history"}</span>{live ? <button className="button button-quiet" onClick={() => setShowPrune(true)}><Trash2 size={14} /> Prune</button> : null}<button className="button button-primary" onClick={onNew}><MessageSquareText size={15} /> New session</button></>} />
      {mutationError ? <div className="inline-alert surface-alert"><ShieldCheck size={14} /><span>{mutationError}</span><button onClick={() => setMutationError("")}><X size={13} /></button></div> : null}
      <div className="session-stats"><div><span>Loaded</span><strong>{sessions.length} sessions</strong><small>{compactNumber(sessions.reduce((sum, item) => sum + item.tokens, 0))} tokens</small></div><div><span>Completed</span><strong>{sessions.filter((item) => item.status === "complete").length} sessions</strong><small>current result set</small></div><div><span>Tool calls</span><strong>{sessions.reduce((sum, item) => sum + item.tools, 0)}</strong><small>recorded traces</small></div><div><span>Estimated cost</span><strong>${sessions.reduce((sum, item) => sum + item.cost, 0).toFixed(2)}</strong><small>Hermes analytics</small></div></div>
      <div className="session-filterbar"><label className="field-search session-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Full-text search messages, tools, and titles…" /></label><label><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="">All sources</option>{sources.map((item) => <option value={item} key={item}>{item}</option>)}</select></label><label><span>Archive</span><select value={archived} onChange={(event) => setArchived(event.target.value as typeof archived)}><option value="exclude">Active store</option><option value="include">All</option><option value="only">Archived only</option></select></label></div>
      <div className="sessions-layout">
        <div className="sessions-table">
          <div className="session-table-head"><span>Conversation</span><span>Model</span><span>Usage</span><span>When</span><span /></div>
          {filteredSessions.map((session) => <button key={session.id} className={selected?.id === session.id ? "is-selected" : ""} onClick={() => setSelectedId(session.id)}><span className="session-title-cell"><i><MessageSquareText size={15} /></i><span><strong>{session.title}</strong><small>{session.preview}</small></span></span><span><em className={`model-badge is-${session.model}`}>{session.model}</em></span><span><strong>{compactNumber(session.tokens)}</strong><small>${session.cost.toFixed(2)} · {session.tools} tools</small></span><span><strong>{session.createdAt.split(" · ")[0]}</strong><small>{session.createdAt.split(" · ")[1]}</small></span><ChevronRight size={14} /></button>)}
          {!filteredSessions.length ? <EmptyState icon={History} title="No sessions yet" copy="A completed Hermes conversation will appear here." /> : null}
        </div>
        {selected ? <aside className="session-preview">
          <div className="session-preview-heading"><div><span className="source-pill"><CheckCircle2 size={11} /> {selected.status}</span><h2>{selected.title}</h2><p>{selected.createdAt} · {selected.model}{selected.source ? ` · ${selected.source}` : ""}{selected.messageCount ? ` · ${selected.messageCount} messages` : ""}</p></div></div>
          <div className="preview-transcript">
            {live && transcriptFor !== selected.id ? <div className="command-loading"><LoaderCircle className="spin" size={17} /> Loading transcript…</div> : null}
            {live && transcriptFor === selected.id && !transcriptError ? transcript.map((entry) => entry.tool
              ? <ToolCard key={entry.id} tool={entry.tool} />
              : <div key={entry.id} className={classNames("preview-turn", entry.role === "user" && "is-user")}><span>{entry.role === "user" ? "YOU" : entry.role.toUpperCase()}</span><p>{entry.content}</p></div>) : null}
            {live && transcriptFor === selected.id && transcriptError ? <div className="inline-alert"><ShieldCheck size={14} /><span>{transcriptError}</span><button onClick={() => setTranscriptReload((value) => value + 1)}>Retry</button></div> : null}
            {!live ? <><div className="preview-turn is-user"><span>YOU</span><p>Turn this idea into an implementable policy, then show the tradeoffs.</p></div><div className="preview-turn"><span>HERMES</span><p>{selected.preview} The strongest policy combines activation decay with stable provenance and explicit rehearsal signals.</p></div><ToolCard tool={{ id: "preview-tool", name: "knowledge.search", status: "complete", input: "memory activation decay", output: "6 relevant notes", elapsed: "94 ms" }} /></> : null}
            {live && transcriptFor === selected.id && !transcriptError && !transcript.length ? <EmptyState icon={History} title="No transcript rows" copy="Hermes returned no stored messages for this session." /> : null}
          </div>
          <div className="session-preview-actions">{live ? <><a className="button button-quiet" href={`/api/control/sessions/${encodeURIComponent(selected.id)}/export?profile=${encodeURIComponent(profileId)}`} download><ArrowDown size={14} /> Export JSON</a><button className="button button-quiet" onClick={() => void archiveSelected()} disabled={busy}>{selected.archived ? "Restore" : "Archive"}</button><button className="button button-danger" onClick={() => void removeSelected()} disabled={busy}><Trash2 size={13} /> Delete</button></> : null}</div>
        </aside> : null}
      </div>
      {showPrune ? <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="prune-title"><button type="button" className="dismiss-layer" onClick={() => setShowPrune(false)} aria-label="Close prune dialog" /><div className="modal-card"><div className="modal-heading"><div><p className="eyebrow">Retention safety</p><h2 id="prune-title">Prune ended sessions</h2></div><button className="icon-button" onClick={() => setShowPrune(false)} aria-label="Close prune dialog"><X size={14} /></button></div><p className="modal-copy">HERMESS binds deletion to the exact previewed IDs, then rechecks each one. Active, pinned, archived, and unverifiable sessions remain protected.</p><label><span>Older than · days</span><input type="number" min={1} max={3650} value={pruneDays} onChange={(event) => { setPruneDays(Number(event.target.value)); setPruneMatch(null); setPruneTooMany(false); setPruneToken(""); }} /></label>{source ? <p className="modal-copy">Source filter: <code>{source}</code></p> : null}{pruneMatch != null ? <div className="inline-alert"><ShieldCheck size={14} /><span>{pruneTooMany ? `${pruneCandidates} candidates exceed the safe batch limit; narrow this policy.` : `${pruneMatch} verified session${pruneMatch === 1 ? "" : "s"} can be deleted${pruneProtected ? `; ${pruneProtected} protected` : ""}.`}</span></div> : null}<div className="modal-actions"><button className="button button-quiet" onClick={() => void previewPrune()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />} Preview</button><button className="button button-danger" onClick={() => void executePrune()} disabled={busy || !pruneMatch || pruneTooMany || !pruneToken}><Trash2 size={14} /> Delete verified</button></div></div></div> : null}
    </div>
  );
}

function AutomationsView({ automations, live, onAutomations, profileId }: { automations: Automation[]; live: boolean; onAutomations: (items: Automation[]) => void; profileId: string }) {
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("0 2 * * *");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [skillsReady, setSkillsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState("");
  const [runLog, setRunLog] = useState<{ automation: Automation; runs: Array<Record<string, unknown>> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (!live) { setAvailableSkills([]); setSkillsReady(false); return; }
      setSkillsReady(false);
      void loadHermesSkills(profileId)
        .then((skills) => { if (!cancelled) { setAvailableSkills([...new Set(skills)].sort()); setSkillsReady(true); } })
        .catch((cause) => { if (!cancelled) { setAvailableSkills([]); setSkillsReady(false); setMutationError(cause instanceof Error ? cause.message : "Hermes skills could not be loaded."); } });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [live, profileId]);

  useDialogGuard(showNew, () => setShowNew(false), saving);
  useDialogGuard(Boolean(runLog), () => setRunLog(null));

  const openNew = () => {
    if (!live) {
      setMutationError("The Hermes scheduler is unavailable. Reconnect before creating an automation.");
      return;
    }
    setEditing(null); setName(""); setPrompt(""); setSchedule("0 2 * * *"); setSelectedSkills(availableSkills.includes("daily-synthesis") ? ["daily-synthesis"] : []); setShowNew(true);
  };
  const openEdit = (automation: Automation) => {
    if (!live) {
      setMutationError("The Hermes scheduler is unavailable. Editing is disabled.");
      return;
    }
    setEditing(automation); setName(automation.name); setPrompt(automation.description); setSchedule(automation.schedule); setSelectedSkills(automation.skills ?? (automation.skill && automation.skill !== "No skill" ? [automation.skill] : [])); setShowNew(true);
  };

  const toggle = async (id: string) => {
    if (!live) {
      setMutationError("The Hermes scheduler is unavailable. No change was made.");
      return;
    }
    const current = automations.find((item) => item.id === id);
    if (!current) return;
    setMutationError("");
    try {
      const updated = await setHermesAutomationEnabled(id, !current.enabled, profileId, current.revision);
      if (!updated) throw new Error("Hermes returned an invalid automation.");
      onAutomations(automations.map((item) => item.id === id ? updated : item));
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Hermes could not update the automation.");
      return;
    }
  };
  const run = async (id: string) => {
    if (!live) {
      setMutationError("The Hermes scheduler is unavailable. Nothing was queued.");
      return;
    }
    setMutationError("");
    setRunning(id);
    onAutomations(automations.map((item) => item.id === id ? { ...item, status: "running" } : item));
    try {
      const current = automations.find((item) => item.id === id);
      if (!current) throw new Error("Refresh this automation before running it.");
      await triggerHermesAutomation(id, profileId, current.revision);
      const refreshed = await loadAutomations(profileId);
      if (!refreshed.live) throw new Error("Hermes accepted the trigger, but the refreshed scheduler state is unavailable.");
      onAutomations(refreshed.items);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Hermes could not queue the automation.");
      onAutomations(automations);
      setRunning(null);
      return;
    }
    setRunning(null);
  };
  const saveAutomation = async (event: FormEvent) => {
    event.preventDefault();
    if (!live) {
      setMutationError("The Hermes scheduler is unavailable. The automation was not saved.");
      return;
    }
    if (!name.trim()) return;
    setMutationError("");
    setSaving(true);
    const normalizedName = name.trim();
    const normalizedPrompt = prompt.trim() || `Run ${normalizedName}.`;
    let created: Automation;
    try {
      created = editing
        ? await updateHermesAutomation(editing.id, { name: normalizedName, schedule, prompt: normalizedPrompt, skills: selectedSkills, profile: profileId, revision: editing.revision })
        : await createHermesAutomation({ name: normalizedName, schedule, prompt: normalizedPrompt, skills: selectedSkills, profile: profileId });
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Hermes could not save the automation.");
      setSaving(false);
      return;
    }
    onAutomations(editing ? automations.map((item) => item.id === editing.id ? created : item) : [...automations, created]);
    setName(""); setPrompt(""); setEditing(null); setShowNew(false); setSaving(false);
  };

  const removeAutomation = async (automation: Automation) => {
    if (!live) {
      setMutationError("The Hermes scheduler is unavailable. Nothing was deleted.");
      return;
    }
    if (!window.confirm(`Delete automation “${automation.name}”?`)) return;
    setRunning(`delete:${automation.id}`); setMutationError("");
    try {
      await deleteHermesAutomation(automation.id, profileId, automation.revision);
      onAutomations(automations.filter((item) => item.id !== automation.id));
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : "Hermes could not delete the automation."); }
    finally { setRunning(null); }
  };

  const openRuns = async (automation: Automation) => {
    if (!live) {
      setMutationError("The Hermes scheduler is unavailable. Run history cannot be loaded.");
      return;
    }
    setRunning(`runs:${automation.id}`); setMutationError("");
    try { setRunLog({ automation, runs: await loadHermesAutomationRuns(automation.id, profileId) }); }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : "Run history is unavailable."); }
    finally { setRunning(null); }
  };

  const totalRuns = automations.reduce((sum, item) => sum + (item.runCount ?? 0), 0);
  const nextJob = automations.find((item) => item.enabled && item.nextRun && item.nextRun !== "pending");
  const selectableSkills = [...new Set([...availableSkills, ...selectedSkills])].sort();

  return (
    <div className="surface automations-surface">
      <SurfaceHeader eyebrow="Autonomous loops" title="Automations" copy="Create, edit, pause, trigger, inspect, and delete profile-scoped Hermes cron jobs." actions={<><span className={classNames("source-pill", live && "is-live")}><Radio size={11} /> {live ? "Hermes cron" : "Scheduler unavailable"}</span><button className="button button-primary" onClick={openNew} disabled={!live || !skillsReady} title={!live ? "Reconnect Hermes to create an automation" : !skillsReady ? "Wait for the profile skill catalogue" : undefined}><Plus size={15} /> New automation</button></>} />
      {!live ? <div className="inline-alert surface-alert"><ShieldCheck size={14} /><span>The Hermes scheduler is unavailable. Automation controls are disabled; no local-only changes will be accepted.</span></div> : null}
      {mutationError ? <div className="inline-alert surface-alert"><ShieldCheck size={14} /><span>{mutationError}</span><button onClick={() => setMutationError("")} aria-label="Dismiss"><X size={13} /></button></div> : null}
      <div className="automation-summary"><div><span className="metric-icon mint"><Play size={15} /></span><p><strong>{automations.filter((item) => item.enabled).length} active</strong><small>{automations.length} listed jobs</small></p></div><div><span className="metric-icon violet"><Check size={15} /></span><p><strong>{totalRuns}</strong><small>reported executions</small></p></div><div><span className="metric-icon amber"><Clock3 size={15} /></span><p><strong>{nextJob?.nextRun ?? "No run queued"}</strong><small>next reported run</small></p></div><div className="cron-health"><StatusDot state={live ? "online" : "checking"} pulse={live} /><p><strong>{live ? "Scheduler API online" : "Scheduler unavailable"}</strong><small>{live ? "Hermes is authoritative" : "Waiting for Hermes cron"}</small></p></div></div>
      <div className="automation-list">
        <div className="automation-list-head"><span>Automation</span><span>Schedule</span><span>Last run</span><span>Status</span><span /></div>
        {automations.map((automation) => (
          <article key={automation.id} className={!automation.enabled ? "is-paused" : ""}>
            <div className="automation-name"><span><TimerReset size={17} /></span><div><strong>{automation.name}</strong><small>{automation.description}</small><em><Braces size={11} /> {(automation.skills?.length ? automation.skills.join(", ") : "Prompt only")}</em></div></div>
            <div><strong>{automation.humanSchedule}</strong><small><code>{automation.schedule}</code> · next {automation.nextRun}</small></div>
            <div><strong>{automation.lastRun}</strong><small>{automation.lastStatus ?? "no execution reported"}</small></div>
            <div><span className={classNames("run-status", automation.status === "running" && "is-running", !automation.enabled && "is-disabled")}><StatusDot state={automation.enabled ? "online" : "offline"} pulse={automation.status === "running"} />{automation.status === "running" ? "Running" : automation.enabled ? "Ready" : "Paused"}</span></div>
            <div className="automation-actions"><button className="icon-button" onClick={() => void toggle(automation.id)} disabled={!live} aria-label={automation.enabled ? `Pause ${automation.name}` : `Resume ${automation.name}`}>{automation.enabled ? <Pause size={14} /> : <Play size={14} />}</button><button className="button button-quiet" onClick={() => void run(automation.id)} disabled={!live || !automation.enabled || running === automation.id}>{running === automation.id ? <LoaderCircle className="spin" size={14} /> : <Play size={13} />} Run now</button><button className="icon-button" onClick={() => void openRuns(automation)} disabled={!live} aria-label={`Run history for ${automation.name}`}>{running === `runs:${automation.id}` ? <LoaderCircle className="spin" size={14} /> : <History size={14} />}</button><button className="icon-button" onClick={() => openEdit(automation)} disabled={!live} aria-label={`Edit ${automation.name}`}><PencilLine size={14} /></button><button className="icon-button danger-icon" onClick={() => void removeAutomation(automation)} disabled={!live} aria-label={`Delete ${automation.name}`}><Trash2 size={14} /></button></div>
          </article>
        ))}
      </div>
      <div className="automation-note"><MoonStar size={18} /><div><strong>Hermes-owned execution</strong><p>Trigger is asynchronous: it queues the next scheduler tick. Open a job’s history to inspect the authoritative run records.</p></div></div>
      {showNew ? <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="automation-editor-title"><button type="button" className="dismiss-layer" onClick={() => setShowNew(false)} aria-label="Close automation dialog" /><form className="modal-card" onSubmit={(event) => void saveAutomation(event)}><div className="modal-heading"><div><p className="eyebrow">Hermes cron</p><h2 id="automation-editor-title">{editing ? `Edit ${editing.name}` : "New automation"}</h2></div><button type="button" className="icon-button" onClick={() => setShowNew(false)} aria-label="Close automation editor"><X size={15} /></button></div><label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Weekly reflection" required /></label><label><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder="Review this week's new notes and surface unresolved questions." required /></label><label><span>Cron schedule</span><input value={schedule} onChange={(event) => setSchedule(event.target.value)} required /><small>Use standard five-field cron syntax in the server timezone.</small></label><fieldset className="skill-picker"><legend>Skills · optional</legend>{selectableSkills.length ? selectableSkills.map((item) => <label key={item}><input type="checkbox" checked={selectedSkills.includes(item)} onChange={(event) => setSelectedSkills((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} /><span>{item}</span></label>) : <p>No skills are installed for this profile. This job will run from its prompt only.</p>}</fieldset><p className="modal-copy">Only the fields shown here are updated; Hermes preserves delivery, model, script, workdir, and toolset settings already attached to an existing job.</p><div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setShowNew(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {editing ? "Save changes" : "Create automation"}</button></div></form></div> : null}
      {runLog ? <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="run-log-title"><button type="button" className="dismiss-layer" onClick={() => setRunLog(null)} aria-label="Close run history" /><div className="modal-card run-log-modal"><div className="modal-heading"><div><p className="eyebrow">Execution history</p><h2 id="run-log-title">{runLog.automation.name}</h2></div><button className="icon-button" onClick={() => setRunLog(null)} aria-label="Close run history"><X size={14} /></button></div>{runLog.runs.length ? <div className="run-log-list">{runLog.runs.map((record, index) => <div key={String(record.id ?? index)}><StatusDot state={record.status === "failed" || record.status === "error" ? "degraded" : "online"} /><span><strong>{String(record.status ?? record.end_reason ?? "recorded")}</strong><small>{String(record.started_at ?? record.created_at ?? "time unavailable")} · {String(record.model ?? runLog.automation.model ?? runLog.automation.skill)}</small></span></div>)}</div> : <EmptyState icon={History} title="No runs recorded" copy="Trigger this job, then refresh its history after the scheduler executes it." />}</div></div> : null}
    </div>
  );
}

function TasksView({ tasks, onTasks }: { tasks: BrainTask[]; onTasks: (tasks: BrainTask[]) => void }) {
  const [showNew, setShowNew] = useState<TaskStatus | null>(null);
  const [filter, setFilter] = useState<"all" | BrainTask["priority"]>("all");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [priority, setPriority] = useState<BrainTask["priority"]>("medium");
  useDialogGuard(Boolean(showNew), () => setShowNew(null));
  const visibleTasks = filter === "all" ? tasks : tasks.filter((task) => task.priority === filter);
  const move = (task: BrainTask, direction: -1 | 1) => {
    const index = taskColumns.findIndex((column) => column.id === task.status);
    const target = taskColumns[index + direction];
    if (!target) return;
    onTasks(tasks.map((item) => item.id === task.id ? { ...item, status: target.id } : item));
  };
  const addTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || !showNew) return;
    onTasks([...tasks, { id: crypto.randomUUID(), title: title.trim(), detail: detail.trim(), status: showNew, priority, tags: [], agent: undefined }]);
    setTitle(""); setDetail(""); setPriority("medium"); setShowNew(null);
  };
  return (
    <div className="surface tasks-surface">
      <SurfaceHeader eyebrow="Local execution" title="Task board" copy="A browser-local board for lightweight work. Hermes runtime agents remain authoritative in Runtime & logs." actions={<><label className="task-filter"><ListFilter size={13} /><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All priorities</option><option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option></select></label><button className="button button-primary" onClick={() => setShowNew("backlog")}><Plus size={15} /> Add task</button></>} />
      <div className="board-toolbar"><div className="board-viewers"><span>H</span><span>Y</span><small>Local to this browser</small></div><div><span><StatusDot state={tasks.some((task) => task.status === "active") ? "online" : "offline"} /> {tasks.filter((task) => task.status === "active").length} in progress</span></div></div>
      <div className="kanban-board">
        {taskColumns.map((column) => {
          const columnTasks = visibleTasks.filter((task) => task.status === column.id);
          return <section key={column.id} className={`kanban-column is-${column.id}`}><header><span /><strong>{column.label}</strong><small>{columnTasks.length}</small><button aria-label={`Add to ${column.label}`} onClick={() => setShowNew(column.id)}><Plus size={13} /></button></header><div className="kanban-stack">{columnTasks.map((task) => <article key={task.id} className="task-card"><div className="task-card-top"><span className={`priority-dot is-${task.priority}`} title={`${task.priority} priority`} /><button className="drag-handle" onClick={() => onTasks(tasks.filter((item) => item.id !== task.id))} aria-label={`Delete ${task.title}`}><Trash2 size={13} /></button></div><h3>{task.title}</h3><p>{task.detail}</p><div className="task-tags">{task.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div><footer><span>{task.agent ? <><Bot size={12} /> {task.agent}</> : <><Inbox size={12} /> Local task</>}</span><div><button onClick={() => move(task, -1)} disabled={column.id === "backlog"} aria-label="Move task left"><ArrowLeft size={12} /></button><button onClick={() => move(task, 1)} disabled={column.id === "done"} aria-label="Move task right"><ArrowRight size={12} /></button></div></footer></article>)}</div><button className="add-card" onClick={() => setShowNew(column.id)}><Plus size={13} /> Add a task</button></section>;
        })}
      </div>
      {showNew ? <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="task-editor-title"><button className="dismiss-layer" onClick={() => setShowNew(null)} aria-label="Close task form" /><form className="modal-card" onSubmit={addTask}><div className="modal-heading"><div><p className="eyebrow">Browser-local board</p><h2 id="task-editor-title">Add to {taskColumns.find((column) => column.id === showNew)?.label}</h2></div><button type="button" className="icon-button" onClick={() => setShowNew(null)} aria-label="Close task form"><X size={14} /></button></div><label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label><span>Detail</span><textarea value={detail} onChange={(event) => setDetail(event.target.value)} rows={4} /></label><label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setShowNew(null)}>Cancel</button><button className="button button-primary" type="submit"><Plus size={14} /> Add task</button></div></form></div> : null}
    </div>
  );
}

function ProfilesView({
  active,
  options,
  live,
  onActive,
  onUpdate,
  snapshot,
}: {
  active: Profile;
  options: Profile[];
  live: boolean;
  onActive: (profile: Profile) => Promise<void>;
  onUpdate: (profile: Profile, provider: Profile["provider"], model: string) => Promise<void>;
  snapshot: SystemSnapshot;
}) {
  const [editing, setEditing] = useState<Profile | null>(null);
  const [provider, setProvider] = useState<Profile["provider"]>("openai-codex");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useDialogGuard(Boolean(editing), () => setEditing(null), saving);

  const openEditor = (profile: Profile) => {
    if (!live || !profile.revision) {
      setError("Hermes profile details are unavailable. Refresh before editing.");
      return;
    }
    setEditing(profile);
    setProvider(profile.provider);
    setModel(profile.model);
    setError("");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!live || !editing?.revision || !model.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onUpdate(editing, provider, model.trim());
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hermes could not update this profile.");
    } finally {
      setSaving(false);
    }
  };

  const activate = async (next: Profile) => {
    if (!live || !next.revision) {
      setError("Hermes profile details are unavailable. Refresh before activating.");
      return;
    }
    setSaving(true);
    setError("");
    try { await onActive(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Hermes could not activate this profile."); }
    finally { setSaving(false); }
  };

  return (
    <div className="surface profiles-surface">
      <SurfaceHeader eyebrow="Model-agnostic by design" title="Profiles & providers" copy="Route deep coding to Codex, keep alternatives warm, and switch without editing YAML." actions={<span className={classNames("source-pill", live && "is-live")}><Radio size={11} /> {live ? "Hermes profiles" : "Profiles unavailable"}</span>} />
      {!live ? <div className="inline-alert surface-alert"><ShieldCheck size={14} /><span>Hermes profiles could not be verified. Editing and activation are disabled.</span></div> : null}
      {error && !editing ? <div className="inline-alert surface-alert"><ShieldCheck size={14} /><span>{error}</span><button onClick={() => setError("")}><X size={13} /></button></div> : null}
      <div className="profiles-layout">
        <div className="profile-grid">
          {options.map((profile) => (
            <article key={profile.id} className={classNames("profile-card", active.id === profile.id && "is-active")}>
              <div className="profile-card-heading"><span className={`profile-emblem ${profile.accent}`}>{profile.provider === "custom" ? <Box size={18} /> : profile.provider === "openai-codex" ? <TerminalSquare size={18} /> : <Hexagon size={18} />}</span><div><span>{profile.provider}</span><h2>{profile.name}</h2></div><button className="icon-button" onClick={() => openEditor(profile)} disabled={!live || !profile.revision} aria-label={`Edit ${profile.name}`}><PencilLine size={14} /></button></div>
              <p>{profile.description}</p>
              <div className="profile-model"><span>Model</span><code>{profile.model}</code></div>
              <div className="profile-specs"><span><small>State</small><strong>{active.id === profile.id ? "Active" : "Available"}</strong></span><span><small>Applies to</small><strong>New sessions</strong></span><span><small>Secrets</small><strong>Server-side</strong></span></div>
              {active.id === profile.id ? <button className="button button-wide button-selected" disabled><Check size={14} /> Active profile</button> : <button className="button button-wide button-quiet" disabled={saving || !live || !profile.revision} onClick={() => void activate(profile)}>{saving ? <LoaderCircle className="spin" size={14} /> : null} Make active</button>}
            </article>
          ))}
        </div>
        <aside className="provider-settings">
          <div className="panel-heading"><div><p className="eyebrow">Runtime routing</p><h2>Configured routes</h2></div><ShieldCheck size={17} /></div>
          <div className="provider-list">
            {options.map((profile) => <div key={profile.id}><span><StatusDot state={snapshot.hermes} /><span><strong>{profile.name}</strong><code>{profile.provider} · {profile.model}</code></span></span><button className="text-button" onClick={() => openEditor(profile)} disabled={!live || !profile.revision}>Edit</button></div>)}
          </div>
          <div className="routing-policy"><div><GitBranch size={16} /><span><strong>Task profile</strong><small>Each new chat request names its provider and model</small></span></div><ol>{options.slice(0, 3).map((profile, index) => <li key={profile.id}><span>{index + 1}</span><p><strong>{profile.name}</strong><small>{profile.provider} · {profile.model}</small></p></li>)}</ol><button className="button button-wide button-quiet" onClick={() => openEditor(active)} disabled={!live || !active.revision}><PencilLine size={14} /> Edit active route</button></div>
          <div className="secure-note"><ShieldCheck size={15} /><p><strong>Secrets stay server-side</strong><span>The browser sees provider names and health—not credential values.</span></p></div>
        </aside>
      </div>
      {editing ? <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title"><button type="button" className="dismiss-layer" onClick={() => setEditing(null)} aria-label="Close profile editor" /><form className="modal-card" onSubmit={(event) => void save(event)}><div className="modal-heading"><div><p className="eyebrow">Hermes profile</p><h2 id="profile-editor-title">Edit {editing.name}</h2></div><button type="button" className="icon-button" onClick={() => setEditing(null)} aria-label="Close profile editor"><X size={15} /></button></div><p className="modal-copy">Changes are persisted by Hermes and apply to new sessions. Existing conversations keep their current model.</p>{error ? <div className="inline-alert"><ShieldCheck size={14} /><span>{error}</span></div> : null}<label><span>Provider</span><select value={provider} onChange={(event) => setProvider(event.target.value)}>{!["openai-codex", "openrouter", "anthropic", "custom"].includes(provider) ? <option value={provider}>{provider}</option> : null}<option value="openai-codex">OpenAI Codex</option><option value="openrouter">OpenRouter</option><option value="anthropic">Anthropic</option><option value="custom">Custom / local</option></select></label><label><span>Model</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-5.6-sol" maxLength={240} required /></label><div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setEditing(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !live || !editing.revision || !model.trim()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save profile</button></div></form></div> : null}
    </div>
  );
}

function CommandPalette({
  onClose,
  onNavigate,
  onOpenKnowledge,
}: {
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onOpenKnowledge: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeItem[]>([]);
  const [searching, setSearching] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const searchSequence = useRef(0);
  useDialogGuard(true, onClose);
  useEffect(() => {
    const timer = window.setTimeout(() => commandInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const sequence = ++searchSequence.current;
    if (!query.trim()) return;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const next = await searchKnowledge(query);
      if (searchSequence.current !== sequence) return;
      setResults(next);
      setSearching(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);
  const quick = navigation.flatMap((group) => group.items).filter((item) => item.label.toLowerCase().includes(query.toLowerCase())).slice(0, 4);
  const handlePaletteKeys = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = Array.from(paletteRef.current?.querySelectorAll<HTMLButtonElement>(".command-results > button") ?? []);
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && buttons[0]) {
      event.preventDefault(); buttons[0].click(); return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1) : Math.max(0, current <= 0 ? 0 : current - 1);
    buttons[next]?.focus();
  };
  return (
    <div className="command-backdrop" role="dialog" aria-modal="true" aria-label="Command palette">
      <button type="button" className="dismiss-layer" onClick={onClose} aria-label="Close command palette" />
      <div className="command-palette" ref={paletteRef}>
        <div className="command-input"><Search size={18} /><input ref={commandInputRef} value={query} onChange={(event) => { const next = event.target.value; setQuery(next); if (!next.trim()) { setResults([]); setSearching(false); } }} onKeyDown={handlePaletteKeys} placeholder="Search your brain or jump somewhere…" aria-label="Search your brain" /><kbd>esc</kbd></div>
        <div className="command-results">
          {quick.length ? <><span className="command-section-label">{query ? "Jump to" : "Navigation"}</span>{quick.map((item) => { const Icon = item.icon; return <button key={`nav-${item.id}`} onKeyDown={handlePaletteKeys} onClick={() => { onNavigate(item.id); onClose(); }}><i><Icon size={15} /></i><span>{item.label}</span><small>Open</small><CornerDownLeft size={13} /></button>; })}</> : null}
          {!query ? <><span className="command-section-label">Quick actions</span><button onKeyDown={handlePaletteKeys} onClick={() => { onNavigate("solari"); onClose(); }}><i><Sparkles size={15} /></i><span>Enter Solari</span><small>Experience</small></button><button onKeyDown={handlePaletteKeys} onClick={() => { onNavigate("chat"); onClose(); }}><i><MessageSquareText size={15} /></i><span>Start a thought with Solari</span><small>Action</small></button><button onKeyDown={handlePaletteKeys} onClick={() => { onNavigate("automations"); onClose(); }}><i><Play size={15} /></i><span>Open automations</span><small>Open</small></button></> : <>{searching ? <div className="command-loading"><LoaderCircle className="spin" size={18} /> Searching the local index…</div> : null}{results.length ? <span className="command-section-label">Knowledge</span> : null}{results.map((item) => { const Icon = kindMeta[item.kind].icon; return <button key={`knowledge-${item.id}`} onKeyDown={handlePaletteKeys} onClick={() => { onOpenKnowledge(item.id); onClose(); }}><i style={{ color: kindMeta[item.kind].color }}><Icon size={15} /></i><span><strong>{item.title}</strong><small>{item.summary}</small></span><em>{Math.round(item.weight * 100)}%</em></button>; })}{!searching && !quick.length && !results.length ? <EmptyState icon={Search} title="No matching knowledge" copy="Try a different phrase or add the first note." /> : null}</>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><small>Semantic search stays local</small></footer>
      </div>
    </div>
  );
}

export function HermessApp() {
  const [view, setView] = useState<ViewId>("solari");
  const [mobileNav, setMobileNav] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [topbarMenu, setTopbarMenu] = useState<"notifications" | "workspace" | null>(null);
  const [profile, setProfile] = useState<Profile>(profiles[0]);
  const [profileOptions, setProfileOptions] = useState<Profile[]>(profiles);
  const [activeProfileId, setActiveProfileId] = useState(profiles[0].id);
  const [liveProfiles, setLiveProfiles] = useState(false);
  const [snapshot, setSnapshot] = useState<SystemSnapshot>(initialSnapshot);
  const [graph, setGraph] = useState<KnowledgeGraph>({ nodes: [], edges: [] });
  const [liveGraph, setLiveGraph] = useState(false);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [liveKnowledge, setLiveKnowledge] = useState(false);
  const [vault, setVault] = useState<KnowledgeVault | null>(null);
  const [libraryTargetId, setLibraryTargetId] = useState<string>();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [liveAutomations, setLiveAutomations] = useState(false);
  const [automationsProfileId, setAutomationsProfileId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [liveSessions, setLiveSessions] = useState(false);
  const [sessionsProfileId, setSessionsProfileId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<BrainTask[]>([]);
  const [tasksHydrated, setTasksHydrated] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexNotice, setReindexNotice] = useState("");
  const profileSelectionRef = useRef(false);
  const profileIdRef = useRef(profile.id);
  const activeProfile = profileOptions.find((item) => item.id === activeProfileId) ?? profile;
  const hasServiceAlert = [snapshot.hermes, snapshot.knowledge, snapshot.gateway].some((state) => state !== "online");

  const refreshSnapshot = useCallback(async () => setSnapshot(await loadSystemSnapshot(profileIdRef.current)), []);
  const refreshGraph = useCallback(async () => {
    const result = await loadKnowledgeGraph();
    setGraph(result.graph); setLiveGraph(result.live);
  }, []);
  const refreshKnowledge = useCallback(async () => {
    const [result, currentVault] = await Promise.all([
      loadKnowledgeItems(),
      loadKnowledgeVault(),
    ]);
    let loadedItems = result.items;
    const first = loadedItems[0];
    if (result.live && first && !first.detailLoaded) {
      try {
        const detail = await loadKnowledgeItem(first.id);
        if (detail) loadedItems = loadedItems.map((item) => item.id === detail.id ? detail : item);
      } catch {
        // The summary remains visible; opening or editing retries the detail.
      }
    }
    setKnowledge(loadedItems);
    setLiveKnowledge(result.live);
    setVault(currentVault);
  }, []);
  const refreshKnowledgeUniverse = useCallback(async () => {
    await Promise.all([refreshKnowledge(), refreshGraph(), refreshSnapshot()]);
  }, [refreshGraph, refreshKnowledge, refreshSnapshot]);
  const applyKnowledgeTrash = useCallback(async (receipt: KnowledgeDeleteReceipt) => {
    setKnowledge((current) => current.filter((item) => item.id !== receipt.id));
    setGraph((current) => ({
      nodes: current.nodes.filter((node) => node.id !== receipt.id),
      edges: current.edges.filter((edge) => edge.source !== receipt.id && edge.target !== receipt.id),
    }));
    // The delete endpoint installs an immediate in-memory tombstone before it
    // returns. A durable full reindex continues in the background when needed,
    // so refreshing here cannot resurrect the removed card.
    await refreshKnowledgeUniverse();
  }, [refreshKnowledgeUniverse]);

  useEffect(() => {
    const initialPoll = window.setTimeout(() => {
      void refreshSnapshot();
      void refreshGraph();
      void refreshKnowledge();
      void loadHermesProfiles(profiles).then((result) => {
        const solariProfile = result.items.find((item) => item.id === "solari");
        setProfileOptions(result.items);
        setLiveProfiles(result.live);
        setActiveProfileId(result.items.some((item) => item.id === result.defaultId) ? result.defaultId! : result.items[0]?.id ?? profiles[0].id);
        setProfile((current) => profileSelectionRef.current
          ? result.items.find((item) => item.id === current.id) ?? result.items[0] ?? current
          : solariProfile ?? result.items.find((item) => item.id === result.defaultId) ?? result.items.find((item) => item.id === current.id) ?? result.items[0] ?? current);
      });
    }, 0);
    const timer = window.setInterval(() => void refreshSnapshot(), 15_000);
    return () => { window.clearTimeout(initialPoll); window.clearInterval(timer); };
  }, [refreshGraph, refreshKnowledge, refreshSnapshot]);

  useEffect(() => {
    profileIdRef.current = profile.id;
    void refreshSnapshot();
  }, [profile.id, refreshSnapshot]);

  useEffect(() => {
    if (!liveProfiles) return;
    let cancelled = false;
    const targetProfile = profile.id;
    void loadSessions("", { profile: targetProfile }).then((result) => {
      if (cancelled) return;
      setSessions(result.items);
      setSessionsProfileId(targetProfile);
      setLiveSessions(result.live);
    });
    void loadAutomations(targetProfile).then((result) => {
      if (cancelled) return;
      setAutomations(result.items);
      setAutomationsProfileId(targetProfile);
      setLiveAutomations(result.live);
    });
    return () => { cancelled = true; };
  }, [liveProfiles, profile.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem("hermess.local-tasks.v1");
        if (saved) {
          const parsed = JSON.parse(saved) as unknown;
          const candidate = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 1 && Array.isArray((parsed as { items?: unknown }).items)
              ? (parsed as { items: unknown[] }).items
              : [];
          setTasks(candidate.filter(isBrainTask));
        }
      } catch { /* A private browser may not expose local storage. */ }
      finally { setTasksHydrated(true); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!tasksHydrated) return;
    try { window.localStorage.setItem("hermess.local-tasks.v1", JSON.stringify({ version: 1, items: tasks })); }
    catch { /* The board remains usable for the current tab. */ }
  }, [tasks, tasksHydrated]);

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); setCommandOpen(true); }
      if (event.key === "Escape") { setCommandOpen(false); setMobileNav(false); setTopbarMenu(null); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const navigate = (next: ViewId) => { setView(next); setMobileNav(false); setTopbarMenu(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openKnowledge = (id: string) => { setLibraryTargetId(id); navigate("library"); };
  const addDiscoveredEdges = useCallback((edges: GraphEdge[]) => setGraph((current) => mergeGraphEdges(current, edges)), []);
  const runReindex = async () => {
    if (!liveKnowledge || reindexing) return;
    setReindexing(true);
    setReindexNotice("");
    try {
      const report = await reindexKnowledge() as { nodes?: unknown; links?: unknown };
      await Promise.all([refreshGraph(), refreshSnapshot()]);
      const nodes = typeof report.nodes === "number" ? report.nodes : undefined;
      const links = typeof report.links === "number" ? report.links : undefined;
      setReindexNotice(nodes === undefined ? "Knowledge index refreshed." : `Indexed ${nodes} nodes${links === undefined ? "" : ` and ${links} links`}.`);
    } catch (cause) {
      setReindexNotice(cause instanceof Error ? cause.message : "Knowledge re-index failed.");
    } finally {
      setReindexing(false);
    }
  };
  const updateProfile = async (current: Profile, provider: Profile["provider"], model: string) => {
    const result = await updateHermesProfileModel(current.id, provider, model, current.revision);
    const updated = { ...current, provider: String(result.provider ?? provider), model: String(result.model ?? model), revision: typeof result._revision === "string" ? result._revision : undefined };
    setProfileOptions((items) => items.map((item) => item.id === current.id ? updated : item));
    setProfile((selected) => selected.id === current.id ? updated : selected);
  };
  const activateProfile = async (next: Profile) => {
    await setHermesActiveProfile(next.id, next.revision);
    profileSelectionRef.current = true;
    setActiveProfileId(next.id);
    setProfile(next);
  };
  const selectProfile = (next: Profile) => {
    profileSelectionRef.current = true;
    setProfile(next);
  };
  const updateScopedSessions = useCallback((items: Session[]) => {
    setSessions(items);
    setSessionsProfileId(profile.id);
  }, [profile.id]);
  const updateScopedAutomations = useCallback((items: Automation[]) => {
    setAutomations(items);
    setAutomationsProfileId(profile.id);
  }, [profile.id]);

  return (
    <div className="app-shell">
      <aside className={classNames("sidebar", mobileNav && "is-open")}>
        <div className="brand-row"><MiniLogo /><span><strong>HERMESS</strong><small>DIGITAL BRAIN</small></span><button className="sidebar-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><PanelLeftClose size={17} /></button></div>
        <nav aria-label="Primary navigation">
          {navigation.map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? "is-active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><Icon size={16} /><span>{item.label}</span>{item.badge ? <em>{item.badge}</em> : null}</button>; })}</div>)}
        </nav>
        <div className="sidebar-spacer" />
        <button className={classNames("profile-nav", view === "profiles" && "is-active")} aria-current={view === "profiles" ? "page" : undefined} onClick={() => navigate("profiles")}><span className={`profile-mark ${activeProfile.accent}`}><Braces size={15} /></span><span><small>Active profile</small><strong>{activeProfile.name}</strong></span><ChevronRight size={14} /></button>
        <div className="sidebar-status"><div><StatusDot state={snapshot.gateway} pulse /><span><strong>Brain {snapshot.gateway === "online" ? "awake" : "waking"}</strong><small>{formatClock(snapshot.checkedAt)}</small></span></div><button className="icon-button" onClick={() => void refreshSnapshot()} aria-label="Refresh system status"><RefreshCw size={13} /></button></div>
      </aside>
      {mobileNav ? <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" /> : null}
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={18} /></button><span>{viewLabels[view].eyebrow}</span><ChevronRight size={12} /><strong>{viewLabels[view].title}</strong></div>
          <button className="global-search" onClick={() => setCommandOpen(true)}><Search size={14} /><span>Search every thought…</span><kbd>⌘ K</kbd></button>
          <div className="topbar-actions">
            <div className="service-cluster"><ServiceBadge label="Hermes" state={snapshot.hermes} /><ServiceBadge label="Index" state={snapshot.knowledge} /></div>
            <button className="icon-button notification-button" aria-label="System notifications" aria-expanded={topbarMenu === "notifications"} aria-controls="notification-menu" onClick={() => setTopbarMenu((current) => current === "notifications" ? null : "notifications")}><Bell size={15} />{hasServiceAlert ? <i /> : null}</button>
            <button className="user-menu" aria-label="Workspace menu" aria-expanded={topbarMenu === "workspace"} aria-controls="workspace-menu" onClick={() => setTopbarMenu((current) => current === "workspace" ? null : "workspace")}><span>H</span><ChevronDown size={12} /></button>
            {topbarMenu ? <button className="topbar-dismiss" onClick={() => setTopbarMenu(null)} aria-label="Close top bar menu" /> : null}
            {topbarMenu === "notifications" ? <div className="topbar-popover" id="notification-menu" role="menu"><header><strong>System status</strong><small>{formatClock(snapshot.checkedAt)}</small></header>{hasServiceAlert ? <div className="topbar-notice"><ShieldCheck size={15} /><span><strong>Attention needed</strong><small>One or more runtime services are not online.</small></span></div> : <div className="topbar-notice is-good"><CheckCircle2 size={15} /><span><strong>All systems online</strong><small>No active runtime alerts.</small></span></div>}<button role="menuitem" onClick={() => navigate("runtime")}><Activity size={14} /> Open runtime & logs <ChevronRight size={13} /></button><button role="menuitem" onClick={() => navigate("library")}><Database size={14} /> Open knowledge vault <ChevronRight size={13} /></button></div> : null}
            {topbarMenu === "workspace" ? <div className="topbar-popover" id="workspace-menu" role="menu"><header><strong>Digital Brain workspace</strong><small>{profile.name} request profile</small></header><button role="menuitem" onClick={() => navigate("profiles")}><Braces size={14} /> Profiles & providers <ChevronRight size={13} /></button><button role="menuitem" onClick={() => navigate("settings")}><Settings2 size={14} /> Configuration <ChevronRight size={13} /></button><button role="menuitem" onClick={() => navigate("runtime")}><Activity size={14} /> Runtime & logs <ChevronRight size={13} /></button></div> : null}
          </div>
        </header>
        <main>
          {view === "solari" ? <SolariExperience graph={graph} knowledge={knowledge} sessions={sessionsProfileId === profile.id ? sessions : []} automations={automationsProfileId === profile.id ? automations : []} snapshot={snapshot} liveGraph={liveGraph} liveKnowledge={liveKnowledge} liveSessions={liveSessions && sessionsProfileId === profile.id} liveAutomations={liveAutomations && automationsProfileId === profile.id} onOpenKnowledge={openKnowledge} onNavigate={navigate} /> : null}
          {view === "overview" ? <BrainstreamView graph={graph} knowledge={knowledge} sessions={sessionsProfileId === profile.id ? sessions : []} automations={automationsProfileId === profile.id ? automations : []} profile={profile} snapshot={snapshot} liveGraph={liveGraph} liveKnowledge={liveKnowledge} liveSessions={liveSessions && sessionsProfileId === profile.id} liveAutomations={liveAutomations && automationsProfileId === profile.id} onOpenKnowledge={openKnowledge} onNavigate={navigate} /> : null}
          {view === "chat" ? <ChatView key={`chat-${profile.id}`} profile={profile} options={profileOptions} onProfile={selectProfile} snapshot={snapshot} /> : null}
          {view === "graph" ? <GraphView graph={graph} live={liveGraph} onReload={refreshGraph} onDiscovered={addDiscoveredEdges} /> : null}
          {view === "library" ? <LibraryView items={knowledge} graph={graph} live={liveKnowledge} onItems={setKnowledge} focusId={libraryTargetId} onFocusConsumed={() => setLibraryTargetId(undefined)} vault={vault} onImported={refreshKnowledgeUniverse} onTrashed={applyKnowledgeTrash} onOpenKnowledge={openKnowledge} /> : null}
          {view === "sessions" ? <SessionsView key={`sessions-${profile.id}`} sessions={sessionsProfileId === profile.id ? sessions : []} live={liveSessions && sessionsProfileId === profile.id} onSessions={updateScopedSessions} profileId={profile.id} onNew={() => navigate("chat")} /> : null}
          {view === "automations" ? <AutomationsView key={`automations-${profile.id}`} automations={automationsProfileId === profile.id ? automations : []} live={liveAutomations && automationsProfileId === profile.id} onAutomations={updateScopedAutomations} profileId={profile.id} /> : null}
          {view === "tasks" ? <TasksView tasks={tasks} onTasks={setTasks} /> : null}
          {view === "runtime" ? <RuntimeView key={`runtime-${profile.id}`} profileId={profile.id} /> : null}
          {view === "analytics" ? <AnalyticsView key={`analytics-${profile.id}`} profileId={profile.id} /> : null}
          {view === "capabilities" ? <CapabilitiesView key={`capabilities-${profile.id}`} profileId={profile.id} /> : null}
          {view === "settings" ? <SettingsView key={`settings-${profile.id}`} profileId={profile.id} /> : null}
          {view === "profiles" ? <ProfilesView active={activeProfile} options={profileOptions} live={liveProfiles} onActive={activateProfile} onUpdate={updateProfile} snapshot={snapshot} /> : null}
        </main>
        <footer className="app-footer"><span><StatusDot state={snapshot.gateway} /> Gateway</span><span>{reindexNotice || "Your Markdown stays authoritative"}</span><button onClick={() => void runReindex()} disabled={reindexing || !liveKnowledge} title={!liveKnowledge ? "Knowledge service is unavailable" : undefined}>{reindexing ? <LoaderCircle className="spin" size={11} /> : <Database size={11} />}{reindexing ? "Indexing…" : "Re-index knowledge"}</button><small>HERMESS · DIGITAL BRAIN</small></footer>
      </div>
      {commandOpen ? <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={navigate} onOpenKnowledge={openKnowledge} /> : null}
    </div>
  );
}
