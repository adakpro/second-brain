type JsonRecord = Record<string, unknown>;

export type SolariBrainSearchResult = {
  id: string;
  title: string;
  kind: string;
  summary: string;
  tags: string[];
  score?: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clippedText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

export function normalizeSolariBrainSearch(payload: unknown, limit = 5): SolariBrainSearchResult[] {
  const safeLimit = Math.max(1, Math.min(8, Math.floor(limit)));
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.results)
      ? payload.results
      : [];

  return rows.slice(0, 24).flatMap((row) => {
    if (!isRecord(row)) return [];
    const node = isRecord(row.node) ? row.node : row;
    const title = clippedText(node.title, 160);
    if (!title) return [];
    const score = typeof row.score === "number" && Number.isFinite(row.score)
      ? Math.max(0, Math.min(1, row.score))
      : undefined;
    const tags = Array.isArray(node.tags)
      ? node.tags.map((tag) => clippedText(tag, 48)).filter(Boolean).slice(0, 6)
      : [];
    return [{
      id: clippedText(node.id, 200),
      title,
      kind: clippedText(node.kind, 32) || "knowledge",
      // `/search` returns NodeSummary under `node`; its useful snippet is
      // `excerpt`. The fallbacks retain compatibility with older sidecars.
      summary: clippedText(node.excerpt, 420) || clippedText(node.summary, 420) || clippedText(node.content, 420),
      tags,
      ...(score === undefined ? {} : { score: Number(score.toFixed(4)) }),
    }];
  }).slice(0, safeLimit);
}
