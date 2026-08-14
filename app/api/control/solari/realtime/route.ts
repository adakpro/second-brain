import { sameOriginMutation } from "@/lib/server/hermes-dashboard";
import {
  BodyLimitError,
  InvalidTextBodyError,
  MAX_SDP_REQUEST_BYTES,
  SOLARI_REALTIME_VOICE,
  acquireRealtimeCapacity,
  createRealtimeCall,
  readBoundedText,
  realtimeApiKey,
  realtimeEnabled,
  realtimeModel,
} from "@/lib/server/solari/realtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(detail: string, status: number, headers?: HeadersInit) {
  return Response.json(
    { detail },
    { status, headers: { ...NO_STORE_HEADERS, ...headers } },
  );
}

function sanitizedUpstreamError(status: number, retryAfter: string | null) {
  if (status === 429) {
    const seconds = Number(retryAfter);
    const boundedRetry = Number.isFinite(seconds)
      ? String(Math.max(1, Math.min(120, Math.ceil(seconds))))
      : "10";
    return json("Realtime voice is temporarily rate limited.", 429, { "Retry-After": boundedRetry });
  }
  if (status === 401 || status === 403) {
    return json("Realtime voice is not configured correctly.", 503);
  }
  return json("Realtime voice could not create a session.", 502);
}

export async function GET() {
  const apiKey = await realtimeApiKey();
  return Response.json(
    {
      enabled: realtimeEnabled(),
      configured: Boolean(apiKey),
      model: realtimeModel(),
      voice: SOLARI_REALTIME_VOICE,
    },
    { headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return json("Same-origin request required.", 403);
  if (!realtimeEnabled()) return json("Realtime voice is disabled.", 503);

  const apiKey = await realtimeApiKey();
  if (!apiKey) return json("Realtime voice is not configured.", 503);

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/sdp") return json("Content-Type must be application/sdp.", 415);

  const capacity = acquireRealtimeCapacity();
  if (!capacity.ok) {
    return json("Realtime voice is busy. Try again shortly.", 429, {
      "Retry-After": String(capacity.retryAfterSeconds),
    });
  }

  try {
    let offer: string;
    try {
      offer = await readBoundedText(request.body, request.headers, MAX_SDP_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof BodyLimitError) return json("SDP offer is too large.", 413);
      if (error instanceof InvalidTextBodyError) return json("SDP offer must be valid UTF-8 text.", 400);
      return json("SDP offer could not be read.", 400);
    }

    if (!offer.trimStart().startsWith("v=0") || offer.includes("\0")) {
      return json("Invalid SDP offer.", 400);
    }

    try {
      const result = await createRealtimeCall(offer, apiKey);
      if (!result.ok) return sanitizedUpstreamError(result.status, result.retryAfter);
      return new Response(result.answer, {
        status: result.status,
        headers: {
          ...NO_STORE_HEADERS,
          "Content-Type": "application/sdp",
        },
      });
    } catch (error) {
      if (error instanceof BodyLimitError || error instanceof InvalidTextBodyError) {
        return json("Realtime voice returned an invalid session response.", 502);
      }
      if (error instanceof Error && error.name === "AbortError") {
        return json("Realtime voice session creation timed out.", 504);
      }
      return json("Realtime voice is unavailable.", 502);
    }
  } finally {
    capacity.release();
  }
}
