"use client";

import {
  ArrowUpRight,
  Bot,
  BrainCircuit,
  Braces,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  FileText,
  Lightbulb,
  Network,
  Pin,
  PinOff,
  Radio,
  RotateCcw,
  Search,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Automation,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  KnowledgeGraph,
  KnowledgeItem,
  Profile,
  Session,
  ServiceState,
  SystemSnapshot,
  ViewId,
} from "@/lib/types";
import styles from "./brainstream-view.module.css";

const PIN_STORAGE_KEY = "hermess.brainstream.pins.v1";
const MAX_PINS = 32;
const INITIAL_VISIBLE_CARDS = 72;
const CARD_BATCH_SIZE = 48;
const compactDateFormatter = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" });

type SortMode = "curated" | "connected" | "recent" | "title";
type StorageState = "loading" | "persistent" | "session";

type KindPresentation = {
  label: string;
  plural: string;
  icon: LucideIcon;
};

const kindPresentation: Record<GraphNodeKind, KindPresentation> = {
  note: { label: "Note", plural: "Notes", icon: FileText },
  memory: { label: "Memory", plural: "Memories", icon: BrainCircuit },
  skill: { label: "Skill", plural: "Skills", icon: Braces },
  insight: { label: "Insight", plural: "Insights", icon: Lightbulb },
  task: { label: "Task", plural: "Tasks", icon: CheckCircle2 },
};

const kinds = Object.keys(kindPresentation) as GraphNodeKind[];

export interface BrainstreamViewProps {
  graph: KnowledgeGraph;
  knowledge: KnowledgeItem[];
  sessions: Session[];
  automations: Automation[];
  profile: Profile;
  snapshot: SystemSnapshot;
  liveGraph: boolean;
  liveKnowledge: boolean;
  liveSessions: boolean;
  liveAutomations: boolean;
  loading?: boolean;
  onOpenKnowledge: (id: string) => void;
  onOpenSession?: (id: string) => void;
  onOpenAutomation?: (id: string) => void;
  onNavigate?: (view: ViewId) => void;
}

type CatalogEntry = KnowledgeItem & { availableIn?: number };

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function stableHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function safeDate(value?: string) {
  if (!value) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function finiteDegree(item: Pick<GraphNode, "degree">) {
  return typeof item.degree === "number" && Number.isFinite(item.degree) ? item.degree : 0;
}

function compactDate(value?: string) {
  if (!value) return "No update time";
  const timestamp = safeDate(value);
  if (!Number.isFinite(timestamp)) return value;
  return compactDateFormatter.format(new Date(timestamp));
}

function normalizedText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function graphNodeAsItem(node: GraphNode): KnowledgeItem {
  return {
    ...node,
    content: node.summary,
    detailLoaded: false,
  };
}

function canonicalSkillPath(path?: string) {
  if (!path) return "";
  return path
    .replace(/^hermes-skills\//, "")
    .replace(/^hermes-profile-[^/]+-skills\//, "");
}

function readPins(value: string | null): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  const ids = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 1
      ? (parsed as { ids?: unknown }).ids
      : [];
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, MAX_PINS);
}

function serviceLabel(state: ServiceState) {
  if (state === "online") return "online";
  if (state === "checking") return "checking";
  if (state === "degraded") return "degraded";
  return "offline";
}

function relationKind(edge: GraphEdge) {
  if (edge.kind === "explicit") return "Reference";
  if (edge.kind === "co-occurrence") return "Shared context";
  if (edge.kind === "semantic") return "Semantic";
  return "Connection";
}

function SourceState({ live, children }: { live: boolean; children: React.ReactNode }) {
  return (
    <span className={classNames(styles.sourceState, live ? styles.isLive : styles.isQuiet)}>
      <Radio size={10} aria-hidden="true" /> {children}
    </span>
  );
}

function KindGlyph({ kind, size = 16 }: { kind: GraphNodeKind; size?: number }) {
  const Icon = kindPresentation[kind].icon;
  return <Icon size={size} aria-hidden="true" />;
}

function SkeletonBoard() {
  return (
    <div className={styles.skeletonBoard} aria-live="polite" aria-busy="true">
      <span className={styles.visuallyHidden}>Loading the knowledge stream…</span>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
        <div className={styles.skeletonCard} key={item}>
          <span className={styles.skeletonPoster} />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function EmptyBoard({
  offline,
  filtered,
  onReset,
  onNavigate,
}: {
  offline: boolean;
  filtered: boolean;
  onReset: () => void;
  onNavigate?: (view: ViewId) => void;
}) {
  return (
    <div className={styles.emptyBoard} role="status">
      <span className={styles.emptyOrb}>{offline ? <WifiOff size={22} /> : <Sparkles size={22} />}</span>
      <strong>{filtered ? "No ideas in this constellation" : offline ? "The knowledge stream is offline" : "Your canvas is ready"}</strong>
      <p>
        {filtered
          ? "Clear a filter or try a wider phrase to bring more notes into view."
          : offline
            ? "Reconnect the Knowledge service to browse the live vault. Preview graph data is intentionally not shown here."
            : "Capture or import a note and it will appear here after the knowledge index refreshes."}
      </p>
      {filtered ? (
        <button type="button" className={styles.secondaryButton} onClick={onReset}><RotateCcw size={14} /> Reset view</button>
      ) : offline && onNavigate ? (
        <button type="button" className={styles.secondaryButton} onClick={() => onNavigate("runtime")}><CircleDot size={14} /> Check runtime</button>
      ) : onNavigate ? (
        <button type="button" className={styles.secondaryButton} onClick={() => onNavigate("library")}><FileText size={14} /> Open library</button>
      ) : null}
    </div>
  );
}

type KnowledgeCardProps = {
  item: CatalogEntry;
  degree: number;
  pinned: boolean;
  onOpen: (id: string) => void;
  onPin: (id: string) => void;
  onTag: (tag: string) => void;
};

function KnowledgeCard({ item, degree, pinned, onOpen, onPin, onTag }: KnowledgeCardProps) {
  const variation = stableHash(item.id) % 3;
  const tags = item.tags.slice(0, 5);
  const signal = Number.isFinite(item.weight) && item.weight > 0 ? Math.round(item.weight * 100) : null;
  const copy = item.summary || item.content;

  return (
    <article
      className={classNames(styles.knowledgeCard, styles[`cardVariation${variation}`])}
      data-kind={item.kind}
      role="listitem"
    >
      <div className={styles.cardPoster} aria-hidden="true">
        <div className={styles.posterOrbit}><span /><span /><span /></div>
        <span className={styles.posterGlyph}><KindGlyph kind={item.kind} size={20} /></span>
        <span className={styles.posterKind}>{kindPresentation[item.kind].label}</span>
        {signal !== null ? <span className={styles.posterSignal}>{signal}% graph strength</span> : null}
      </div>
      <div className={styles.cardTopline}>
        <span>{item.availableIn && item.availableIn > 1 ? `${item.availableIn} installs · ${item.status ?? kindPresentation[item.kind].label}` : item.status ?? kindPresentation[item.kind].label}</span>
        <button
          type="button"
          className={classNames(styles.pinButton, pinned && styles.isPinned)}
          onClick={() => onPin(item.id)}
          aria-label={`${pinned ? "Unpin" : "Pin"} ${item.title}`}
          aria-pressed={pinned}
          title={pinned ? "Remove from this device's Focus shelf" : "Pin to this device's Focus shelf"}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      </div>
      <button type="button" className={styles.cardOpen} onClick={() => onOpen(item.id)}>
        <strong>{item.title}</strong>
        <span>{copy || "Open this item to read its indexed content."}</span>
        <em>Open in library <ArrowUpRight size={12} /></em>
      </button>
      {tags.length ? (
        <div className={styles.cardTags} aria-label={`Tags for ${item.title}`}>
          {tags.map((tag) => <button type="button" key={tag} onClick={() => onTag(tag)}>#{tag}</button>)}
        </div>
      ) : null}
      <footer className={styles.cardFooter}>
        <span>{compactDate(item.updatedAt)}</span>
        <span><Network size={11} /> {degree} link{degree === 1 ? "" : "s"}</span>
      </footer>
    </article>
  );
}

function FocusShelf({
  items,
  missing,
  storageState,
  onOpen,
  onUnpin,
}: {
  items: KnowledgeItem[];
  missing: number;
  storageState: StorageState;
  onOpen: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const shelfRef = useRef<HTMLDivElement>(null);
  const scroll = (direction: -1 | 1) => shelfRef.current?.scrollBy({ left: direction * 310, behavior: "smooth" });

  return (
    <section className={styles.focusShelf} aria-labelledby="focus-shelf-title">
      <div className={styles.sectionHeading}>
        <div>
          <p>Personal board</p>
          <h2 id="focus-shelf-title">Focus shelf</h2>
          <span>{storageState === "persistent" ? "Saved only on this device" : storageState === "session" ? "Available in this view; browser storage is unavailable" : "Reading this device…"}</span>
        </div>
        {items.length ? (
          <div className={styles.shelfControls}>
            <span>{items.length} available{missing ? ` · ${missing} unavailable` : ""}</span>
            <button type="button" onClick={() => scroll(-1)} aria-label="Scroll Focus shelf left"><ChevronLeft size={15} /></button>
            <button type="button" onClick={() => scroll(1)} aria-label="Scroll Focus shelf right"><ChevronRight size={15} /></button>
          </div>
        ) : null}
      </div>
      {items.length ? (
        <div className={styles.shelfTrack} ref={shelfRef} role="list">
          {items.map((item) => (
            <article className={styles.shelfCard} data-kind={item.kind} key={item.id} role="listitem">
              <span className={styles.shelfGlyph}><KindGlyph kind={item.kind} /></span>
              <button type="button" onClick={() => onOpen(item.id)}>
                <small>{kindPresentation[item.kind].label}</small>
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
              </button>
              <button type="button" className={styles.shelfUnpin} onClick={() => onUnpin(item.id)} aria-label={`Unpin ${item.title}`}><X size={13} /></button>
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.shelfEmpty}>
          <Pin size={16} />
          <span><strong>Nothing pinned yet</strong><small>Pin an idea below to build a device-local focus board.</small></span>
        </div>
      )}
    </section>
  );
}

function SerendipityMixer({
  edges,
  byId,
  onOpen,
  onGraph,
}: {
  edges: GraphEdge[];
  byId: Map<string, KnowledgeItem>;
  onOpen: (id: string) => void;
  onGraph?: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const safeCursor = edges.length ? cursor % edges.length : 0;
  const edge = edges[safeCursor];
  const source = edge ? byId.get(edge.source) : undefined;
  const target = edge ? byId.get(edge.target) : undefined;
  const sharedTags = source && target ? source.tags.filter((tag) => target.tags.includes(tag)) : [];

  return (
    <section className={styles.mixer} aria-labelledby="mixer-title">
      <div className={styles.mixerHeading}>
        <div>
          <p>Serendipity engine</p>
          <h2 id="mixer-title">Remix two real ideas</h2>
        </div>
        <button type="button" onClick={() => setCursor((value) => edges.length ? (value + 1) % edges.length : 0)} disabled={edges.length < 2}>
          <Shuffle size={14} /> Remix
        </button>
      </div>
      {edge && source && target ? (
        <div className={styles.mixerBody} aria-live="polite">
          <button type="button" className={styles.mixerNode} data-kind={source.kind} onClick={() => onOpen(source.id)}>
            <span><KindGlyph kind={source.kind} /></span>
            <small>{kindPresentation[source.kind].label}</small>
            <strong>{source.title}</strong>
          </button>
          <div className={styles.mixerRelation}>
            <span><Sparkles size={13} /></span>
            <strong>{edge.relation}</strong>
            <small>{relationKind(edge)} · {Math.round(edge.weight * 100)}%</small>
          </div>
          <button type="button" className={styles.mixerNode} data-kind={target.kind} onClick={() => onOpen(target.id)}>
            <span><KindGlyph kind={target.kind} /></span>
            <small>{kindPresentation[target.kind].label}</small>
            <strong>{target.title}</strong>
          </button>
          <div className={styles.reflectionPrompt}>
            <span>Reflection prompt</span>
            <p>What becomes possible when <strong>{source.title}</strong> is viewed through <strong>{target.title}</strong>?</p>
            <small>{sharedTags.length ? `Shared tags: ${sharedTags.map((tag) => `#${tag}`).join(" · ")}` : "This prompt comes from an indexed graph connection; it is not an AI-generated claim."}</small>
          </div>
        </div>
      ) : (
        <div className={styles.mixerEmpty}>
          <Network size={18} />
          <span><strong>No connected pair in this view</strong><small>Widen the filters or discover links in the graph.</small></span>
          {onGraph ? <button type="button" onClick={onGraph}>Open graph <ArrowUpRight size={12} /></button> : null}
        </div>
      )}
    </section>
  );
}

function ActivityRail({
  sessions,
  automations,
  profile,
  snapshot,
  liveSessions,
  liveAutomations,
  onOpenSession,
  onOpenAutomation,
  onNavigate,
}: Pick<BrainstreamViewProps, "sessions" | "automations" | "profile" | "snapshot" | "liveSessions" | "liveAutomations" | "onOpenSession" | "onOpenAutomation" | "onNavigate">) {
  const recentSessions = sessions.slice(0, 3);
  const nextAutomation = automations.find((item) => item.enabled);
  const openSession = (id: string) => onOpenSession ? onOpenSession(id) : onNavigate?.("sessions");
  const openAutomation = (id: string) => onOpenAutomation ? onOpenAutomation(id) : onNavigate?.("automations");

  return (
    <aside className={styles.activityRail} aria-label="Digital brain activity">
      <section className={styles.runtimeCard}>
        <div className={styles.railHeading}><div><p>Room pulse</p><h2>Right now</h2></div><span className={styles.profileMark}>{profile.name.slice(0, 1).toUpperCase()}</span></div>
        <div className={styles.serviceList}>
          {(["hermes", "knowledge", "gateway"] as const).map((service) => (
            <div key={service}><i data-state={snapshot[service]} /><span><strong>{service}</strong><small>{serviceLabel(snapshot[service])}</small></span></div>
          ))}
        </div>
        <div className={styles.activeProfile}>
          <Bot size={15} />
          <span><small>Thinking profile</small><strong>{profile.name}</strong><em>{profile.model}</em></span>
        </div>
      </section>

      <section className={styles.railCard}>
        <div className={styles.railHeading}>
          <div><p>Continuity</p><h2>Recent sessions</h2></div>
          <SourceState live={liveSessions}>{liveSessions ? "Live" : "Unavailable"}</SourceState>
        </div>
        {recentSessions.length ? (
          <div className={styles.sessionList}>
            {recentSessions.map((session) => (
              <button type="button" key={session.id} onClick={() => openSession(session.id)} disabled={!onOpenSession && !onNavigate}>
                <span className={styles.sessionState} data-status={session.status}><Clock3 size={13} /></span>
                <span><strong>{session.title}</strong><small>{session.createdAt} · {session.model}</small></span>
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
        ) : <p className={styles.railEmpty}>{liveSessions ? "No sessions are available for this profile." : "Session history is unavailable."}</p>}
      </section>

      <section className={styles.railCard}>
        <div className={styles.railHeading}>
          <div><p>Incubation</p><h2>Next autonomous thought</h2></div>
          <SourceState live={liveAutomations}>{liveAutomations ? "Live" : "Unavailable"}</SourceState>
        </div>
        {nextAutomation ? (
          <button type="button" className={styles.automationCard} onClick={() => openAutomation(nextAutomation.id)} disabled={!onOpenAutomation && !onNavigate}>
            <span className={styles.automationIcon}><Sparkles size={16} /></span>
            <span><strong>{nextAutomation.name}</strong><small>{nextAutomation.description}</small><em>{nextAutomation.nextRun || nextAutomation.humanSchedule}</em></span>
            <ArrowUpRight size={13} />
          </button>
        ) : <p className={styles.railEmpty}>{liveAutomations ? "No enabled automation is queued." : "Automation state is unavailable."}</p>}
      </section>
    </aside>
  );
}

export function BrainstreamView({
  graph,
  knowledge,
  sessions,
  automations,
  profile,
  snapshot,
  liveGraph,
  liveKnowledge,
  liveSessions,
  liveAutomations,
  loading = false,
  onOpenKnowledge,
  onOpenSession,
  onOpenAutomation,
  onNavigate,
}: BrainstreamViewProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<GraphNodeKind | "all">("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sort, setSort] = useState<SortMode>("curated");
  const [pinIds, setPinIds] = useState<string[]>([]);
  const [storageState, setStorageState] = useState<StorageState>("loading");
  const [pinsHydrated, setPinsHydrated] = useState(false);
  const [notice, setNotice] = useState("");
  const [visibleBudget, setVisibleBudget] = useState(INITIAL_VISIBLE_CARDS);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setPinIds(readPins(window.localStorage.getItem(PIN_STORAGE_KEY)));
        setStorageState("persistent");
      } catch {
        setStorageState("session");
      } finally {
        setPinsHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!pinsHydrated || storageState !== "persistent") return;
    try {
      window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify({ version: 1, ids: pinIds, updatedAt: new Date().toISOString() }));
    } catch {
      const timer = window.setTimeout(() => {
        setStorageState("session");
        setNotice("Pins remain in this view, but this browser blocked local storage.");
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [pinIds, pinsHydrated, storageState]);

  useEffect(() => {
    if (storageState !== "persistent") return;
    const syncPins = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key === PIN_STORAGE_KEY) setPinIds(readPins(event.newValue));
    };
    window.addEventListener("storage", syncPins);
    return () => window.removeEventListener("storage", syncPins);
  }, [storageState]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const catalog = useMemo<CatalogEntry[]>(() => {
    const merged = new Map<string, KnowledgeItem>();
    knowledge.forEach((item) => merged.set(item.id, item));
    if (liveGraph) {
      graph.nodes.forEach((node) => {
        const current = merged.get(node.id);
        const graphItem = graphNodeAsItem(node);
        merged.set(node.id, current ? {
          ...graphItem,
          ...current,
          // Node summaries intentionally have no ranking values. Preserve the
          // structural graph metadata instead of letting summary defaults
          // collapse every overlapping card to zero.
          weight: graphItem.weight,
          degree: graphItem.degree,
        } : graphItem);
      });
    }
    const grouped = new Map<string, CatalogEntry>();
    for (const item of merged.values()) {
      // Hermes deliberately imports root/profile copies as separate graph
      // nodes. For visual discovery, byte-identical read-only copies are one
      // idea with multiple scopes; editable vault documents and distinct
      // revisions always remain separate.
      const skillPath = canonicalSkillPath(item.path);
      const key = item.kind === "skill" && !item.editable && item.revision && skillPath
        ? `skill:${skillPath}:${item.revision}`
        : `node:${item.id}`;
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, { ...item, availableIn: item.kind === "skill" && !item.editable ? 1 : undefined });
        continue;
      }
      grouped.set(key, {
        ...current,
        weight: Math.max(current.weight, item.weight),
        degree: Math.max(finiteDegree(current), finiteDegree(item)),
        availableIn: (current.availableIn ?? 1) + 1,
      });
    }
    return [...grouped.values()];
  }, [graph.nodes, knowledge, liveGraph]);

  const byId = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const degree = useMemo(() => {
    const values = new Map<string, number>();
    if (!liveGraph) return values;
    graph.edges.forEach((edge) => {
      values.set(edge.source, (values.get(edge.source) ?? 0) + 1);
      values.set(edge.target, (values.get(edge.target) ?? 0) + 1);
    });
    graph.nodes.forEach((node) => {
      if (typeof node.degree === "number" && Number.isFinite(node.degree)) values.set(node.id, node.degree);
    });
    return values;
  }, [graph.edges, graph.nodes, liveGraph]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    catalog.forEach((item) => item.tags.forEach((tag) => {
      const normalized = tag.trim();
      if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }));
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 16);
  }, [catalog]);

  const kindCounts = useMemo(() => Object.fromEntries(kinds.map((entry) => [entry, catalog.filter((item) => item.kind === entry).length])) as Record<GraphNodeKind, number>, [catalog]);

  const filtered = useMemo(() => {
    const needle = normalizedText(query);
    const originalOrder = new Map(catalog.map((item, index) => [item.id, index]));
    const values = catalog.filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (selectedTags.length && !selectedTags.every((tag) => item.tags.includes(tag))) return false;
      if (!needle) return true;
      return normalizedText([item.title, item.summary, item.content, item.path ?? "", ...item.tags].join(" ")).includes(needle);
    });
    values.sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title);
      if (sort === "connected") return Math.max(finiteDegree(right), degree.get(right.id) ?? 0) - Math.max(finiteDegree(left), degree.get(left.id) ?? 0) || left.title.localeCompare(right.title);
      if (sort === "recent") {
        const leftDate = safeDate(left.updatedAt);
        const rightDate = safeDate(right.updatedAt);
        if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) return rightDate - leftDate;
        if (Number.isFinite(rightDate)) return 1;
        if (Number.isFinite(leftDate)) return -1;
        return (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
      }
      const editable = Number(Boolean(right.editable)) - Number(Boolean(left.editable));
      if (editable) return editable;
      return right.weight - left.weight || Math.max(finiteDegree(right), degree.get(right.id) ?? 0) - Math.max(finiteDegree(left), degree.get(left.id) ?? 0) || (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
    });
    return values;
  }, [catalog, degree, kind, query, selectedTags, sort]);

  const filteredIds = useMemo(() => new Set(filtered.map((item) => item.id)), [filtered]);
  const remixEdges = useMemo(() => liveGraph ? graph.edges
    .filter((edge) => filteredIds.has(edge.source) && filteredIds.has(edge.target) && edge.source !== edge.target)
    .sort((left, right) => right.weight - left.weight || `${left.source}-${left.target}`.localeCompare(`${right.source}-${right.target}`)) : [], [filteredIds, graph.edges, liveGraph]);
  const pinnedItems = useMemo(() => pinIds.map((id) => byId.get(id)).filter((item): item is KnowledgeItem => Boolean(item)), [byId, pinIds]);
  const missingPins = pinIds.length - pinnedItems.length;
  const filtersActive = Boolean(query.trim() || kind !== "all" || selectedTags.length);
  const isLoading = loading || (snapshot.knowledge === "checking" && !knowledge.length && !liveGraph);
  const visibleItems = filtered.slice(0, visibleBudget);
  const hiddenCount = Math.max(0, filtered.length - visibleItems.length);

  const resetFilters = () => {
    setQuery("");
    setKind("all");
    setSelectedTags([]);
    setSort("curated");
    setVisibleBudget(INITIAL_VISIBLE_CARDS);
    searchRef.current?.focus();
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
    setVisibleBudget(INITIAL_VISIBLE_CARDS);
  };

  const togglePin = (id: string) => {
    setPinIds((current) => {
      if (current.includes(id)) {
        setNotice("Removed from your device-local Focus shelf.");
        return current.filter((item) => item !== id);
      }
      if (current.length >= MAX_PINS) {
        setNotice(`The Focus shelf keeps up to ${MAX_PINS} items on this device.`);
        return current;
      }
      setNotice(storageState === "persistent" ? "Pinned to this device." : "Pinned in this view.");
      return [...current, id];
    });
  };

  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      setQuery("");
      setVisibleBudget(INITIAL_VISIBLE_CARDS);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.ambientOne} aria-hidden="true" />
      <div className={styles.ambientTwo} aria-hidden="true" />

      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.heroEyebrow}><Sparkles size={13} /> Digital brain · Today</div>
          <h1>Follow the spark.<br /><span>Find what your mind already knows.</span></h1>
          <p>A living canvas of notes, memories, skills, and connections from your real HERMESS vault.</p>
          {onNavigate ? (
            <div className={styles.heroActions}>
              <button type="button" className={styles.heroPrimary} onClick={() => onNavigate("library")}><FileText size={14} /> Capture an idea</button>
              <button type="button" className={styles.heroSecondary} onClick={() => onNavigate("chat")}><Bot size={14} /> Talk to Solari</button>
            </div>
          ) : null}
          <div className={styles.heroMeta}>
            <SourceState live={liveKnowledge}>{liveKnowledge ? "Live vault" : knowledge.length ? "Cached vault" : "Vault unavailable"}</SourceState>
            <span><CircleDot size={11} /> {catalog.length} curated ideas</span>
            <span><Network size={11} /> {liveGraph ? `${graph.edges.length} indexed links` : "Graph unavailable"}</span>
          </div>
        </div>
        <div className={styles.heroConstellation} aria-hidden="true">
          <span className={styles.heroCore}><BrainCircuit size={31} /></span>
          <i /><i /><i /><i /><i />
          <em>{catalog.length}</em>
          <small>ideas in view</small>
        </div>
      </header>

      <FocusShelf items={pinnedItems} missing={missingPins} storageState={storageState} onOpen={onOpenKnowledge} onUnpin={togglePin} />

      <SerendipityMixer edges={remixEdges} byId={byId} onOpen={onOpenKnowledge} onGraph={onNavigate ? () => onNavigate("graph") : undefined} />

      <section className={styles.discovery} aria-labelledby="brainstream-title">
        <div className={styles.discoveryHeading}>
          <div><p>Idea field</p><h2 id="brainstream-title">Brainstream</h2><span>Browse by curiosity, not folders.</span></div>
          <div className={styles.kindFilters} aria-label="Filter by knowledge type">
            <button type="button" className={kind === "all" ? styles.isActive : ""} onClick={() => { setKind("all"); setVisibleBudget(INITIAL_VISIBLE_CARDS); }} aria-pressed={kind === "all"}>All <span>{catalog.length}</span></button>
            {kinds.map((entry) => {
              const Icon = kindPresentation[entry].icon;
              return <button type="button" key={entry} className={kind === entry ? styles.isActive : ""} onClick={() => { setKind(entry); setVisibleBudget(INITIAL_VISIBLE_CARDS); }} aria-pressed={kind === entry} disabled={!kindCounts[entry]}><Icon size={13} /> {kindPresentation[entry].plural}<span>{kindCounts[entry]}</span></button>;
            })}
          </div>
        </div>

        {tagCounts.length ? (
          <div className={styles.tagConstellation} aria-label="Filter by popular tags">
            <span className={styles.constellationLabel}><Sparkles size={12} /> Constellations</span>
            <div>
              {tagCounts.map(([tag, count]) => {
                const selected = selectedTags.includes(tag);
                const tagStyle = { "--tag-weight": String(Math.min(1.25, 0.85 + count * 0.06)) } as CSSProperties;
                return <button type="button" key={tag} style={tagStyle} className={selected ? styles.isSelected : ""} aria-pressed={selected} onClick={() => toggleTag(tag)}>#{tag}<span>{count}</span></button>;
              })}
            </div>
          </div>
        ) : null}

        <div className={styles.toolbar}>
          <label className={styles.searchBox}>
            <Search size={15} aria-hidden="true" />
            <span className={styles.visuallyHidden}>Search this knowledge stream</span>
            <input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setVisibleBudget(INITIAL_VISIBLE_CARDS); }} onKeyDown={handleSearchKey} placeholder="Search this stream…" type="search" />
            {query ? <button type="button" onClick={() => { setQuery(""); setVisibleBudget(INITIAL_VISIBLE_CARDS); searchRef.current?.focus(); }} aria-label="Clear search"><X size={13} /></button> : null}
          </label>
          <label className={styles.sortControl}>
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span className={styles.visuallyHidden}>Sort knowledge</span>
            <select value={sort} onChange={(event) => { setSort(event.target.value as SortMode); setVisibleBudget(INITIAL_VISIBLE_CARDS); }}>
              <option value="curated">Curated mix</option>
              <option value="connected">Most connected</option>
              <option value="recent">Recently updated</option>
              <option value="title">Alphabetical</option>
            </select>
          </label>
          <span className={styles.resultCount} aria-live="polite">{filtered.length} of {catalog.length}</span>
          {filtersActive ? <button type="button" className={styles.resetButton} onClick={resetFilters}><RotateCcw size={13} /> Reset</button> : null}
        </div>

        <div className={styles.streamLayout}>
          <div className={styles.streamMain}>
            {isLoading ? <SkeletonBoard /> : filtered.length ? (
              <>
              <div className={styles.masonry} role="list" aria-label="Knowledge cards">
                {visibleItems.map((item) => (
                  <KnowledgeCard
                    key={item.id}
                    item={item}
                    degree={Math.max(finiteDegree(item), degree.get(item.id) ?? 0)}
                    pinned={pinIds.includes(item.id)}
                    onOpen={onOpenKnowledge}
                    onPin={togglePin}
                    onTag={toggleTag}
                  />
                ))}
              </div>
              {hiddenCount ? (
                <div className={styles.loadMore}>
                  <p><strong>{visibleItems.length}</strong> of <strong>{filtered.length}</strong> matching ideas are on the canvas.</p>
                  <button type="button" onClick={() => setVisibleBudget((current) => Math.min(filtered.length, current + CARD_BATCH_SIZE))}>
                    <Sparkles size={14} /> Load {Math.min(CARD_BATCH_SIZE, hiddenCount)} more
                  </button>
                </div>
              ) : null}
              </>
            ) : (
              <EmptyBoard offline={!liveKnowledge && !knowledge.length && !liveGraph} filtered={filtersActive} onReset={resetFilters} onNavigate={onNavigate} />
            )}
          </div>
          <ActivityRail sessions={sessions} automations={automations} profile={profile} snapshot={snapshot} liveSessions={liveSessions} liveAutomations={liveAutomations} onOpenSession={onOpenSession} onOpenAutomation={onOpenAutomation} onNavigate={onNavigate} />
        </div>
      </section>

      <div className={styles.pinNotice} role="status" aria-live="polite" aria-atomic="true">{notice}</div>
    </div>
  );
}
