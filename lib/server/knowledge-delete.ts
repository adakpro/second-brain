const DEFAULT_KNOWLEDGE_URL = "http://knowledge:8000";

export const KNOWLEDGE_DELETE_TIMEOUT_MS = 15_000;
export const MAX_KNOWLEDGE_DELETE_REQUEST_BYTES = 2 * 1024;
export const MAX_KNOWLEDGE_DELETE_RESPONSE_BYTES = 128 * 1024;

const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION = /^[a-f0-9]{64}$/;

export class KnowledgeDeleteLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeDeleteLimitError";
  }
}

export function knowledgeDeleteConfig() {
  const rawUrl = process.env.KNOWLEDGE_API_URL?.trim() || DEFAULT_KNOWLEDGE_URL;
  const apiKey = process.env.KNOWLEDGE_API_KEY?.trim() ?? "";
  if (!apiKey || /[\r\n\0]/.test(apiKey)) return null;

  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { baseUrl: url.toString().replace(/\/$/, ""), apiKey };
  } catch {
    return null;
  }
}

export function validKnowledgeNodeId(value: string) {
  return SAFE_NODE_ID.test(value);
}

export function validKnowledgeRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validVaultRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096) return false;
  if (value !== value.trim() || value.startsWith("/") || value.includes("\\") || /[\0\r\n]/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function normalizeKnowledgeDeleteReceipt(value: unknown, expectedId: string) {
  const payload = record(value);
  if (!payload || !validKnowledgeNodeId(expectedId)) return null;
  const allowed = new Set(["id", "status", "recovery", "trashed_path", "index_state", "original_trashed"]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) return null;
  if (
    payload.id !== expectedId
    || payload.status !== "trashed"
    || payload.recovery !== "available"
    || !validVaultRelativePath(payload.trashed_path)
    || (payload.index_state !== "ready" && payload.index_state !== "pending")
    || typeof payload.original_trashed !== "boolean"
  ) return null;
  return {
    id: payload.id,
    status: payload.status,
    recovery: payload.recovery,
    trashed_path: payload.trashed_path,
    index_state: payload.index_state,
    original_trashed: payload.original_trashed,
  };
}

export function knowledgeDeleteUrl(nodeId: string) {
  if (!validKnowledgeNodeId(nodeId)) return null;
  const config = knowledgeDeleteConfig();
  if (!config) return null;
  return {
    url: `${config.baseUrl}/nodes/${encodeURIComponent(nodeId)}`,
    apiKey: config.apiKey,
  };
}

export function numericDeleteContentLength(headers: Headers) {
  const raw = headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new KnowledgeDeleteLimitError("Knowledge delete payload exceeded its limit.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function readKnowledgeDeleteRequest(request: Request) {
  const declared = numericDeleteContentLength(request.headers);
  if (declared !== undefined && declared > MAX_KNOWLEDGE_DELETE_REQUEST_BYTES) {
    throw new KnowledgeDeleteLimitError("Knowledge delete request exceeded its limit.");
  }
  const text = await readBoundedStream(request.body, MAX_KNOWLEDGE_DELETE_REQUEST_BYTES);
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function readKnowledgeDeleteResponse(response: Response) {
  const declared = numericDeleteContentLength(response.headers);
  if (declared !== undefined && declared > MAX_KNOWLEDGE_DELETE_RESPONSE_BYTES) {
    throw new KnowledgeDeleteLimitError("Knowledge delete response exceeded its limit.");
  }
  return readBoundedStream(response.body, MAX_KNOWLEDGE_DELETE_RESPONSE_BYTES);
}
