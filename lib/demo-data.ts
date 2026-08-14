import type {
  Automation,
  BrainTask,
  ChatMessage,
  KnowledgeGraph,
  KnowledgeItem,
  Profile,
  Session,
} from "./types";

export const demoKnowledge: KnowledgeItem[] = [
  {
    id: "note-agent-memory",
    title: "Agent memory should decay with grace",
    kind: "note",
    summary: "A retrieval policy that favors relevance without erasing the long tail.",
    tags: ["memory", "architecture"],
    weight: 0.94,
    updatedAt: "12 min ago",
    status: "permanent",
    content:
      "Memory needs a half-life, but deletion is the wrong metaphor. Let activation decay while provenance remains stable. Rehearsal, explicit links, and successful retrieval should strengthen a note.",
  },
  {
    id: "memory-room-context",
    title: "The room prefers concise operational updates",
    kind: "memory",
    summary: "Stable communication preference captured from repeated sessions.",
    tags: ["preference", "communication"],
    weight: 0.86,
    updatedAt: "Today",
    status: "permanent",
    content:
      "For background work, report only meaningful state changes. Lead with outcomes and keep tool narration out of the foreground.",
  },
  {
    id: "insight-local-first",
    title: "Local-first is a trust affordance",
    kind: "insight",
    summary: "Privacy is not merely deployment topology; it changes how freely ideas are captured.",
    tags: ["local-first", "trust"],
    weight: 0.91,
    updatedAt: "Yesterday",
    status: "growing",
    content:
      "When search and memory remain local, the capture threshold drops. That behavioral effect—not only compliance—is the real product advantage.",
  },
  {
    id: "skill-research-synthesis",
    title: "research-synthesis",
    kind: "skill",
    summary: "Collects sources, separates evidence from inference, and graduates durable notes.",
    tags: ["skill", "research"],
    weight: 0.78,
    updatedAt: "2 days ago",
    status: "permanent",
    content:
      "Inputs: a research question and source constraints. Outputs: source notes, a synthesis note, unresolved questions, and candidate links.",
  },
  {
    id: "note-cornelius-patterns",
    title: "Cornelius patterns worth preserving",
    kind: "note",
    summary: "Incubation, permanent notes, and surprising connections form one continuous loop.",
    tags: ["product", "second-brain"],
    weight: 0.82,
    updatedAt: "3 days ago",
    status: "growing",
    content:
      "The system should make capture effortless, but apply friction at graduation. Connection discovery should explain why two notes are related.",
  },
  {
    id: "skill-code-architect",
    title: "code-architect",
    kind: "skill",
    summary: "Routes complex repository work to the high-capability Codex profile.",
    tags: ["skill", "codex", "engineering"],
    weight: 0.88,
    updatedAt: "4 days ago",
    status: "permanent",
    content:
      "Use for multi-file changes, migrations, deep debugging, and tool-heavy engineering. Require a validation pass before handoff.",
  },
  {
    id: "note-nightly-incubation",
    title: "Nightly incubation protocol",
    kind: "note",
    summary: "A low-noise loop for revisiting new material and suggesting links.",
    tags: ["automation", "synthesis"],
    weight: 0.74,
    updatedAt: "5 days ago",
    status: "seed",
    content:
      "Re-index changed notes, activate neighbors, propose at most five novel connections, then write a dated synthesis without rewriting source material.",
  },
  {
    id: "memory-provider-policy",
    title: "Provider routing policy",
    kind: "memory",
    summary: "Codex for deep engineering; local or economical models for routine synthesis.",
    tags: ["providers", "routing"],
    weight: 0.71,
    updatedAt: "1 week ago",
    status: "permanent",
    content:
      "Default to the Codex profile for code and tool use. Let scheduled housekeeping use a local model when configured.",
  },
];

export const demoGraph: KnowledgeGraph = {
  nodes: demoKnowledge.map((item) => ({
    id: item.id,
    title: item.title,
    kind: item.kind,
    summary: item.summary,
    tags: item.tags,
    weight: item.weight,
    updatedAt: item.updatedAt,
  })),
  edges: [
    { source: "note-agent-memory", target: "memory-room-context", relation: "informs", weight: 0.71 },
    { source: "note-agent-memory", target: "insight-local-first", relation: "supports", weight: 0.84 },
    { source: "insight-local-first", target: "note-cornelius-patterns", relation: "extends", weight: 0.79 },
    { source: "note-cornelius-patterns", target: "note-nightly-incubation", relation: "implements", weight: 0.91 },
    { source: "skill-research-synthesis", target: "note-nightly-incubation", relation: "runs", weight: 0.87 },
    { source: "skill-research-synthesis", target: "note-cornelius-patterns", relation: "uses", weight: 0.61 },
    { source: "skill-code-architect", target: "memory-provider-policy", relation: "governed by", weight: 0.94 },
    { source: "memory-provider-policy", target: "note-nightly-incubation", relation: "routes", weight: 0.68 },
    { source: "memory-room-context", target: "skill-code-architect", relation: "guides", weight: 0.57 },
    { source: "note-agent-memory", target: "note-nightly-incubation", relation: "tested by", weight: 0.63 },
  ],
};

export const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    createdAt: "Now",
    content: "Signal acquired. What are we making dangerously interesting today?",
  },
];

export const demoSessions: Session[] = [
  { id: "s1", title: "Design the memory decay policy", preview: "Compared recency decay with rehearsal-based activation…", model: "codex", tokens: 18420, cost: 0.84, tools: 7, createdAt: "Today · 14:32", status: "complete" },
  { id: "s2", title: "Refactor ingestion pipeline", preview: "Split parsing, embedding, and graph persistence into isolated stages…", model: "codex", tokens: 32180, cost: 1.42, tools: 14, createdAt: "Today · 09:18", status: "complete" },
  { id: "s3", title: "Morning synthesis", preview: "Three themes emerged across yesterday’s capture…", model: "local", tokens: 4280, cost: 0, tools: 3, createdAt: "Today · 06:00", status: "complete" },
  { id: "s4", title: "Map project dependencies", preview: "Scanning active project notes and linked skills…", model: "codex", tokens: 8650, cost: 0.39, tools: 5, createdAt: "Yesterday · 20:44", status: "complete" },
  { id: "s5", title: "Weekly review", preview: "12 notes graduated, 4 questions remain unresolved…", model: "openrouter", tokens: 11900, cost: 0.22, tools: 8, createdAt: "Friday · 17:30", status: "complete" },
];

export const demoAutomations: Automation[] = [
  { id: "a1", name: "Nightly incubation", description: "Re-index, activate neighbors, and write a compact connection report.", schedule: "0 2 * * *", humanSchedule: "Every day at 02:00", nextRun: "in 7h 24m", lastRun: "Today · 02:00", enabled: true, status: "idle", skill: "research-synthesis" },
  { id: "a2", name: "Morning brief", description: "Summarize open tasks, calendar context, and overnight discoveries.", schedule: "0 6 * * 1-5", humanSchedule: "Weekdays at 06:00", nextRun: "in 11h 24m", lastRun: "Today · 06:00", enabled: true, status: "idle", skill: "daily-brief" },
  { id: "a3", name: "Friday permanent-note review", description: "Surface mature seed notes for deliberate graduation.", schedule: "30 16 * * 5", humanSchedule: "Friday at 16:30", nextRun: "in 3 days", lastRun: "Friday · 16:30", enabled: false, status: "idle", skill: "note-curator" },
];

export const demoTasks: BrainTask[] = [
  { id: "t1", title: "Define retrieval evaluation set", detail: "Create 20 representative queries with expected note neighborhoods.", status: "backlog", priority: "high", tags: ["memory", "evals"] },
  { id: "t2", title: "Import project journals", detail: "Normalize frontmatter and preserve original links.", status: "backlog", priority: "medium", tags: ["ingestion"] },
  { id: "t3", title: "Trace gateway latency", detail: "Separate provider time from tool execution and SSE buffering.", status: "active", priority: "high", tags: ["observability"], agent: "Hermes" },
  { id: "t4", title: "Review connection candidates", detail: "Four pairs passed the nightly activation threshold.", status: "active", priority: "medium", tags: ["knowledge"], agent: "You" },
  { id: "t5", title: "Test local model fallback", detail: "Disconnect primary provider and exercise the synthesis profile.", status: "review", priority: "high", tags: ["resilience"], agent: "Hermes" },
  { id: "t6", title: "Tune note graduation prompt", detail: "Reduce generic summaries; preserve claims and provenance.", status: "review", priority: "low", tags: ["prompts"] },
  { id: "t7", title: "Secure edge gateway", detail: "Basic auth, internal-only ports, and rotated service keys.", status: "done", priority: "high", tags: ["security"] },
  { id: "t8", title: "Create first incubation run", detail: "Scheduled nightly job with an explainable link report.", status: "done", priority: "medium", tags: ["automation"] },
];

export const profiles: Profile[] = [
  { id: "solari", name: "Solari Ultra", provider: "openai-codex", model: "gpt-5.6-sol", description: "Maximum-effort creative orchestration with memory, tools, and a 96-role specialist guild.", context: "Max", temperature: 0.4, accent: "violet" },
  { id: "codex", name: "Deep Work", provider: "openai-codex", model: "gpt-5.6-sol", description: "Complex code, repository edits, and tool-heavy reasoning.", context: "High", temperature: 0.2, accent: "mint" },
  { id: "openrouter", name: "Generalist", provider: "openrouter", model: "anthropic/claude-sonnet-4.6", description: "Balanced conversation and broad synthesis through OpenRouter.", context: "Medium", temperature: 0.5, accent: "violet" },
  { id: "anthropic", name: "Long Context", provider: "anthropic", model: "claude-sonnet-4-6", description: "Long-form reading and careful editorial work.", context: "High", temperature: 0.4, accent: "amber" },
  { id: "local-vllm", name: "Local Quiet", provider: "custom", model: "local-model", description: "Private, economical background synthesis via local vLLM.", context: "Local", temperature: 0.3, accent: "blue" },
];
