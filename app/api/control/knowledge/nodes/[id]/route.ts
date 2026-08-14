import { randomUUID } from "node:crypto";

import { sameOriginMutation } from "@/lib/server/hermes-dashboard";
import {
  KNOWLEDGE_DELETE_TIMEOUT_MS,
  KnowledgeDeleteLimitError,
  knowledgeDeleteUrl,
  normalizeKnowledgeDeleteReceipt,
  readKnowledgeDeleteRequest,
  readKnowledgeDeleteResponse,
  validKnowledgeNodeId,
  validKnowledgeRevision,
} from "@/lib/server/knowledge-delete";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(detail: string, status: number, headers?: HeadersInit) {
  return Response.json({ detail }, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
}

function parseJson(text: string) {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function upstreamFailure(status: number, retryAfter: string | null) {
  if (status === 403) return json("Only editable notes in your vault can be moved to Trash.", 403);
  if (status === 404) return json("This note no longer exists. Refresh your knowledge view.", 404);
  if (status === 409) return json("This note changed after it was opened. The latest knowledge view must be refreshed before retrying.", 409);
  if (status === 422) return json("Knowledge rejected this Trash request. Refresh the note before retrying.", 422);
  if (status === 428) return json("Refresh this note before moving it to Trash.", 428);
  if (status === 429) {
    const raw = Number(retryAfter);
    const seconds = Number.isFinite(raw) ? Math.max(1, Math.min(60, Math.ceil(raw))) : 3;
    return json("Knowledge is busy. Retry in a moment.", 429, { "Retry-After": String(seconds) });
  }
  if (status === 401) return json("Knowledge Trash is not configured correctly.", 503);
  if (status >= 500) return json("Knowledge could not confirm the Trash operation.", 502);
  return json("The note could not be moved to Trash.", 400);
}

export async function DELETE(request: Request, context: Context) {
  if (!sameOriginMutation(request)) return json("Same-origin request required.", 403);

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return json("Content-Type must be application/json.", 415);

  const { id } = await context.params;
  if (!validKnowledgeNodeId(id)) return json("A valid knowledge node is required.", 400);

  let body: Record<string, unknown> | null;
  try {
    body = await readKnowledgeDeleteRequest(request);
  } catch (error) {
    if (error instanceof KnowledgeDeleteLimitError) return json("Trash request body is too large.", 413);
    return json("Trash request body is invalid.", 400);
  }
  if (!body) return json("A JSON request body is required.", 400);
  if (Object.keys(body).some((key) => key !== "expected_revision")) {
    return json("Trash only accepts expected_revision.", 422);
  }
  if (!validKnowledgeRevision(body.expected_revision)) {
    return json("Refresh this note before moving it to Trash.", 428);
  }

  const target = knowledgeDeleteUrl(id);
  if (!target) return json("Knowledge Trash is not configured.", 503);

  const controller = new AbortController();
  const abortFromClient = () => controller.abort();
  request.signal.addEventListener("abort", abortFromClient, { once: true });
  const timeout = setTimeout(() => controller.abort(), KNOWLEDGE_DELETE_TIMEOUT_MS);
  try {
    const upstream = await fetch(target.url, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": target.apiKey,
        "X-Request-ID": randomUUID(),
      },
      body: JSON.stringify({ expected_revision: body.expected_revision }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      return upstreamFailure(upstream.status, upstream.headers.get("retry-after"));
    }

    const text = await readKnowledgeDeleteResponse(upstream);
    const payload = normalizeKnowledgeDeleteReceipt(parseJson(text), id);
    if (!payload) return json("Knowledge returned an invalid Trash confirmation.", 502);
    return Response.json(payload, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof KnowledgeDeleteLimitError) return json("Knowledge returned an invalid Trash confirmation.", 502);
    if (error instanceof Error && error.name === "AbortError") {
      return request.signal.aborted
        ? json("The Trash request was cancelled before confirmation.", 499)
        : json("Knowledge Trash timed out before confirmation.", 504);
    }
    return json("Knowledge Trash is unavailable. No move was confirmed.", 502);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
  }
}
