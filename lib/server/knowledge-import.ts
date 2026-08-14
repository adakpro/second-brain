const DEFAULT_KNOWLEDGE_URL = "http://knowledge:8000";

// The sidecar permits 64 MiB of file payload. Multipart boundaries, filenames,
// and policy fields need bounded headroom beyond that authoritative sum.
export const MAX_IMPORT_PROXY_BYTES = 68 * 1024 * 1024;
export const MAX_IMPORT_RESPONSE_BYTES = 4 * 1024 * 1024;
export const IMPORT_UPSTREAM_TIMEOUT_MS = 120_000;

const RATE_WINDOW_MS = 5 * 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
// The knowledge sidecar intentionally serializes private-vault commits and
// indexing. Reject another upload immediately instead of letting it outlive
// the BFF timeout while waiting behind a full extraction batch.
const MAX_CONCURRENT_REQUESTS = 1;

const recentStarts: number[] = [];
let activeRequests = 0;

export class ImportBodyLimitError extends Error {
  constructor() {
    super("Import body exceeds the allowed size.");
    this.name = "ImportBodyLimitError";
  }
}

export class ImportResponseLimitError extends Error {
  constructor() {
    super("Knowledge import response exceeds the allowed size.");
    this.name = "ImportResponseLimitError";
  }
}

type ImportCapacityLease =
  | { ok: false; retryAfterSeconds: number }
  | { ok: true; release: () => void };

type LimitedBody = {
  stream: ReadableStream<Uint8Array>;
  state: { exceeded: boolean };
};

export function knowledgeImportProxyLimit() {
  // Fixed in lockstep with Caddy's request_body ceiling. Backend file limits
  // remain configurable below this transport boundary.
  return MAX_IMPORT_PROXY_BYTES;
}

export function knowledgeImportConfig() {
  const rawUrl = process.env.KNOWLEDGE_API_URL?.trim() || DEFAULT_KNOWLEDGE_URL;
  const apiKey = process.env.KNOWLEDGE_API_KEY?.trim() ?? "";
  if (!apiKey || /[\r\n\0]/.test(apiKey)) return null;

  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return {
      baseUrl: url.toString().replace(/\/$/, ""),
      apiKey,
    };
  } catch {
    return null;
  }
}

export function multipartBoundary(contentType: string | null) {
  if (!contentType || contentType.length > 512 || /[\r\n\0]/.test(contentType)) return null;
  const [mediaType, ...parameters] = contentType.split(";");
  if (mediaType.trim().toLowerCase() !== "multipart/form-data") return null;

  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0 || parameter.slice(0, separator).trim().toLowerCase() !== "boundary") continue;
    let value = parameter.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.length < 1 || value.length > 200 || /[\r\n\0]/.test(value)) return null;
    return value;
  }
  return null;
}

export function numericContentLength(headers: Headers) {
  const raw = headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function limitImportBody(
  body: ReadableStream<Uint8Array> | null,
  maximum = knowledgeImportProxyLimit(),
): LimitedBody | null {
  if (!body) return null;
  const state = { exceeded: false };
  let received = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maximum) {
        state.exceeded = true;
        controller.error(new ImportBodyLimitError());
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return { stream: body.pipeThrough(transform), state };
}

export async function readBoundedResponse(
  response: Response,
  maximum = MAX_IMPORT_RESPONSE_BYTES,
) {
  const declared = numericContentLength(response.headers);
  if (declared !== undefined && declared > maximum) throw new ImportResponseLimitError();
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let value = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new ImportResponseLimitError();
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    return value;
  } catch (error) {
    if (error instanceof ImportResponseLimitError) throw error;
    throw new Error("Knowledge import returned invalid text.", { cause: error });
  } finally {
    reader.releaseLock();
  }
}

export function acquireImportCapacity(now = Date.now()): ImportCapacityLease {
  const cutoff = now - RATE_WINDOW_MS;
  while (recentStarts.length && recentStarts[0] <= cutoff) recentStarts.shift();

  if (activeRequests >= MAX_CONCURRENT_REQUESTS) return { ok: false, retryAfterSeconds: 3 };
  if (recentStarts.length >= MAX_REQUESTS_PER_WINDOW) {
    const retryAt = recentStarts[0] + RATE_WINDOW_MS;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000)) };
  }

  recentStarts.push(now);
  activeRequests += 1;
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
    },
  };
}

export function knowledgeImportUrl(path: "/imports" | "/imports/capabilities") {
  const config = knowledgeImportConfig();
  if (!config) return null;
  return {
    url: `${config.baseUrl}${path}`,
    apiKey: config.apiKey,
  };
}
