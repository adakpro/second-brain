import { dashboardRequest, sameOriginMutation } from "@/lib/server/hermes-dashboard";
import { identifierPattern, readObjectBody } from "@/lib/server/control-input";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;
type Candidate = { id: string };

const MAX_PRUNE_CANDIDATES = 200;
const DETAIL_CONCURRENCY = 8;
const PREVIEW_TTL_MS = 5 * 60_000;
type PreviewGrant = { profile: string; days: number; source: string; candidates: Candidate[]; expiresAt: number };
const previewGrants = new Map<string, PreviewGrant>();

async function readJson(response: Response): Promise<JsonRecord> {
  const value = await response.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

async function loadDetails(candidates: Candidate[], profile: string) {
  const rows: Array<{ candidate: Candidate; detail: JsonRecord | null }> = [];
  for (let offset = 0; offset < candidates.length; offset += DETAIL_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + DETAIL_CONCURRENCY);
    rows.push(...await Promise.all(batch.map(async (candidate) => {
      try {
        const response = await dashboardRequest(`/api/sessions/${encodeURIComponent(candidate.id)}?profile=${encodeURIComponent(profile)}`);
        return { candidate, detail: response.ok ? await readJson(response) : null };
      } catch {
        return { candidate, detail: null };
      }
    })));
  }
  return rows;
}

function protection(detail: JsonRecord | null): "pinned" | "archived" | "active" | "unverified" | null {
  if (!detail) return "unverified";
  if (detail.pinned === true) return "pinned";
  if (detail.archived === true) return "archived";
  if (detail.is_active === true || detail.active === true || detail.status === "active") return "active";
  return null;
}

function protectionCounts(rows: Awaited<ReturnType<typeof loadDetails>>) {
  const counts = { protected_pinned: 0, protected_archived: 0, protected_active: 0, protected_unverified: 0 };
  const safe: Candidate[] = [];
  for (const row of rows) {
    const reason = protection(row.detail);
    if (!reason) safe.push(row.candidate);
    else counts[`protected_${reason}`] += 1;
  }
  return { safe, ...counts };
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return Response.json({ detail: "Same-origin request required" }, { status: 403 });
  const input = await readObjectBody(request);
  const days = Number(input?.older_than_days);
  const profile = typeof input?.profile === "string" && identifierPattern.test(input.profile) ? input.profile : "default";
  const source = typeof input?.source === "string" ? input.source.trim().slice(0, 120) : "";
  const dryRun = input?.dry_run === true;
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return Response.json({ detail: "older_than_days must be between 1 and 3650" }, { status: 422 });
  }

  try {
    const now = Date.now();
    for (const [token, grant] of previewGrants) {
      if (grant.expiresAt <= now) previewGrants.delete(token);
    }
    if (!dryRun) {
      const previewToken = typeof input?.preview_token === "string" ? input.preview_token : "";
      const grant = previewGrants.get(previewToken);
      previewGrants.delete(previewToken);
      if (!grant || grant.expiresAt <= now || grant.profile !== profile || grant.days !== days || grant.source !== source) {
        return Response.json({ detail: "The prune preview expired or no longer matches. Preview again before deleting." }, { status: 409 });
      }
      const checked = protectionCounts(await loadDetails(grant.candidates, profile));
      let removed = 0;
      let failed = 0;
      let protectedAfterPreview = grant.candidates.length - checked.safe.length;
      for (const candidate of checked.safe) {
        const [fresh] = await loadDetails([candidate], profile);
        if (protection(fresh?.detail ?? null)) {
          protectedAfterPreview += 1;
          continue;
        }
        try {
          const response = await dashboardRequest(`/api/sessions/${encodeURIComponent(candidate.id)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" });
          if (response.ok) removed += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      return Response.json({
        ok: true,
        dry_run: false,
        matched: grant.candidates.length,
        candidate_count: grant.candidates.length,
        removed,
        failed,
        protected_pinned: checked.protected_pinned,
        protected_archived: checked.protected_archived,
        protected_active: checked.protected_active,
        protected_unverified: checked.protected_unverified,
        protected_after_preview: protectedAfterPreview,
        too_many: false,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // Hermes' native bulk prune does not protect pinned sessions. Always ask it
    // only for a candidate list, then verify every row before any deletion.
    const previewResponse = await dashboardRequest("/api/sessions/prune", {
      method: "POST",
      body: JSON.stringify({
        older_than_days: days,
        ...(source ? { source } : {}),
        profile,
        include_archived: false,
        dry_run: true,
      }),
    });
    const preview = await readJson(previewResponse);
    if (!previewResponse.ok) {
      return Response.json({ detail: typeof preview.detail === "string" ? preview.detail : "Hermes could not preview session pruning" }, { status: previewResponse.status });
    }
    const sessions = Array.isArray(preview.sessions) ? preview.sessions : [];
    const candidates = sessions.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const id = (value as JsonRecord).id;
      return typeof id === "string" && id ? [{ id }] : [];
    });
    const candidateCount = typeof preview.matched === "number" ? preview.matched : candidates.length;
    if (candidateCount > MAX_PRUNE_CANDIDATES || candidates.length > MAX_PRUNE_CANDIDATES) {
      const payload = {
        ok: true,
        dry_run: true,
        matched: 0,
        candidate_count: candidateCount,
        protected_pinned: 0,
        protected_archived: 0,
        protected_active: 0,
        protected_unverified: Math.max(0, candidateCount - candidates.length),
        too_many: true,
        limit: MAX_PRUNE_CANDIDATES,
      };
      return dryRun
        ? Response.json(payload, { headers: { "Cache-Control": "no-store" } })
        : Response.json({ ...payload, detail: `Narrow the policy to at most ${MAX_PRUNE_CANDIDATES} candidates before deleting.` }, { status: 422 });
    }

    const checked = protectionCounts(await loadDetails(candidates, profile));
    const previewToken = randomUUID();
    previewGrants.set(previewToken, { profile, days, source, candidates: checked.safe, expiresAt: now + PREVIEW_TTL_MS });
    const result = {
      ok: true,
      dry_run: true,
      matched: checked.safe.length,
      candidate_count: candidateCount,
      protected_pinned: checked.protected_pinned,
      protected_archived: checked.protected_archived,
      protected_active: checked.protected_active,
      protected_unverified: checked.protected_unverified,
      too_many: false,
      preview_token: previewToken,
      expires_in_seconds: PREVIEW_TTL_MS / 1000,
    };
    return Response.json({ ...result, removed: 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ detail: "Hermes session service is unavailable" }, { status: 503 });
  }
}
