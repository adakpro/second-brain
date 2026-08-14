import { randomUUID } from "node:crypto";

import { sameOriginMutation } from "@/lib/server/hermes-dashboard";
import {
  IMPORT_UPSTREAM_TIMEOUT_MS,
  ImportResponseLimitError,
  acquireImportCapacity,
  knowledgeImportProxyLimit,
  knowledgeImportUrl,
  limitImportBody,
  multipartBoundary,
  numericContentLength,
  readBoundedResponse,
} from "@/lib/server/knowledge-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

type StreamingRequestInit = RequestInit & { duplex: "half" };

function json(detail: string, status: number, headers?: HeadersInit) {
  return Response.json(
    { detail },
    { status, headers: { ...NO_STORE_HEADERS, ...headers } },
  );
}

function safeJson(text: string) {
  try {
    const payload = JSON.parse(text) as unknown;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function upstreamFailure(status: number, retryAfter: string | null) {
  if (status === 413) return json("The selected import exceeds the server size limit. Nothing was written.", 413);
  if (status === 415) return json("One or more file formats are not supported. Validation failed before this file could be committed.", 415);
  if (status === 422) return json("One or more files could not be validated or extracted. Retry is content-hash safe; verify the vault if earlier files in this batch had already committed.", 422);
  if (status === 409) return json("The vault changed while this batch was committing. Retry is content-hash safe and will preserve existing imports.", 409);
  if (status === 429) {
    const raw = Number(retryAfter);
    const seconds = Number.isFinite(raw) ? Math.max(1, Math.min(300, Math.ceil(raw))) : 10;
    return json("Knowledge import is busy. Retry shortly.", 429, { "Retry-After": String(seconds) });
  }
  if (status === 401 || status === 403) return json("Knowledge import is not configured correctly.", 503);
  if (status >= 500) return json("The knowledge service could not complete this batch. Some earlier files may be durable; verify the vault or retry safely by content hash.", 502);
  return json("The knowledge service rejected this import. Nothing was written.", 400);
}

async function proxyCapabilities() {
  const upstreamTarget = knowledgeImportUrl("/imports/capabilities");
  if (!upstreamTarget) return json("Knowledge import is not configured.", 503);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(upstreamTarget.url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": upstreamTarget.apiKey,
        "X-Request-ID": randomUUID(),
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      return upstreamFailure(upstream.status, upstream.headers.get("retry-after"));
    }
    const text = await readBoundedResponse(upstream, 128 * 1024);
    const payload = safeJson(text);
    if (!payload) return json("Knowledge import returned invalid capabilities.", 502);
    return Response.json(payload, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof ImportResponseLimitError) return json("Knowledge import returned invalid capabilities.", 502);
    if (error instanceof Error && error.name === "AbortError") return json("Knowledge import capability check timed out.", 504);
    return json("Knowledge import is unavailable.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  return proxyCapabilities();
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return json("Same-origin request required.", 403);

  const contentType = request.headers.get("content-type");
  if (!multipartBoundary(contentType)) return json("Content-Type must be multipart/form-data with a boundary.", 415);

  const proxyLimit = knowledgeImportProxyLimit();
  const declaredLength = numericContentLength(request.headers);
  if (declaredLength !== undefined && declaredLength > proxyLimit) {
    return json("The selected import exceeds the proxy size limit. Nothing was written.", 413);
  }
  if (!request.body) return json("At least one file is required.", 400);

  const upstreamTarget = knowledgeImportUrl("/imports");
  if (!upstreamTarget) return json("Knowledge import is not configured.", 503);

  const capacity = acquireImportCapacity();
  if (!capacity.ok) {
    return json("Knowledge import is busy. Retry shortly.", 429, {
      "Retry-After": String(capacity.retryAfterSeconds),
    });
  }

  const limited = limitImportBody(request.body, proxyLimit);
  if (!limited) {
    capacity.release();
    return json("At least one file is required.", 400);
  }

  const controller = new AbortController();
  const abortFromClient = () => controller.abort();
  request.signal.addEventListener("abort", abortFromClient, { once: true });
  const timeout = setTimeout(() => controller.abort(), IMPORT_UPSTREAM_TIMEOUT_MS);

  try {
    const upstreamInit: StreamingRequestInit = {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": contentType ?? "",
        "X-API-Key": upstreamTarget.apiKey,
        "X-Request-ID": randomUUID(),
      },
      body: limited.stream,
      cache: "no-store",
      signal: controller.signal,
      duplex: "half",
    };
    const upstream = await fetch(upstreamTarget.url, upstreamInit);

    if (limited.state.exceeded) {
      await upstream.body?.cancel().catch(() => undefined);
      return json("The selected import exceeds the proxy size limit. Nothing was written.", 413);
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      return upstreamFailure(upstream.status, upstream.headers.get("retry-after"));
    }

    const text = await readBoundedResponse(upstream);
    const payload = safeJson(text);
    if (!payload) return json("Knowledge import returned an invalid result.", 502);
    return Response.json(payload, {
      status: upstream.status === 201 ? 201 : 200,
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    if (limited.state.exceeded) return json("The selected import exceeds the proxy size limit. Nothing was written.", 413);
    if (error instanceof ImportResponseLimitError) return json("Knowledge import returned an invalid result.", 502);
    if (error instanceof Error && error.name === "AbortError") {
      return request.signal.aborted
        ? json("The import was cancelled before completion. Verify the vault before retrying.", 499)
        : json("Knowledge extraction timed out. No write was confirmed; verify the vault before retrying.", 504);
    }
    return json("Knowledge import is unavailable. No write was confirmed; verify the vault before retrying.", 502);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
    capacity.release();
  }
}
