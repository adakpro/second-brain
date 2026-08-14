export type ImportNode = {
  id?: string;
  title?: string;
  path?: string;
  obsidian_uri?: string;
  index_state?: "ready" | "pending";
};

export type KnowledgeImportResult = {
  filename: string;
  status: "imported" | "duplicate";
  node?: ImportNode;
  sha256?: string;
  media_type?: string;
  extractor?: string;
};

export type KnowledgeImportBatch = {
  results: KnowledgeImportResult[];
  index_state?: "ready" | "pending";
};

export type ImportCapabilities = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  extensions: string[];
  mediaTypes: string[];
  malwareScan: boolean | null;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

function normalizeExtension(value: string) {
  const extension = value.toLowerCase().trim();
  return extension.startsWith(".") ? extension : `.${extension}`;
}

export function normalizeImportCapabilities(value: unknown): ImportCapabilities | null {
  if (!isRecord(value)) return null;
  const maxFiles = positiveInteger(value.max_files);
  const maxFileBytes = positiveInteger(value.max_file_bytes);
  const maxTotalBytes = positiveInteger(value.max_total_bytes);
  const extensions = stringList(value.accepted_extensions ?? value.extensions).map(normalizeExtension);
  const mediaTypes = stringList(value.accepted_media_types ?? value.media_types);
  if (!maxFiles || !maxFileBytes || !maxTotalBytes || !extensions.length) return null;
  return {
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    extensions,
    mediaTypes,
    malwareScan: typeof value.malware_scan === "boolean" ? value.malware_scan : null,
  };
}

export function parseKnowledgeImportBatch(value: unknown): KnowledgeImportBatch | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;
  const results = value.results.flatMap((candidate): KnowledgeImportResult[] => {
    if (!isRecord(candidate) || typeof candidate.filename !== "string") return [];
    if (candidate.status !== "imported" && candidate.status !== "duplicate") return [];
    const node = isRecord(candidate.node) ? candidate.node as ImportNode : undefined;
    return [{
      filename: candidate.filename,
      status: candidate.status,
      node,
      sha256: typeof candidate.sha256 === "string" ? candidate.sha256 : undefined,
      media_type: typeof candidate.media_type === "string" ? candidate.media_type : undefined,
      extractor: typeof candidate.extractor === "string" ? candidate.extractor : undefined,
    }];
  });
  if (results.length !== value.results.length) return null;
  return {
    results,
    index_state: value.index_state === "ready" || value.index_state === "pending" ? value.index_state : undefined,
  };
}

export function reconcileImportResults<T extends { id: string; filename: string }>(
  entries: readonly T[],
  results: readonly KnowledgeImportResult[],
) {
  if (entries.length !== results.length) return null;
  const candidates = results.map((result) => ({ result, used: false }));
  const reconciled = new Map<string, KnowledgeImportResult>();
  for (const entry of entries) {
    const match = candidates.find((candidate) => !candidate.used && candidate.result.filename === entry.filename)
      ?? candidates.find((candidate) => !candidate.used);
    if (!match) return null;
    match.used = true;
    reconciled.set(entry.id, match.result);
  }
  return reconciled;
}

export async function notifyKnowledgeImported(
  batch: KnowledgeImportBatch,
  callback?: (value: KnowledgeImportBatch) => void | Promise<void>,
) {
  if (!callback || !batch.results.some((result) => result.status === "imported")) return false;
  await callback(batch);
  return true;
}
