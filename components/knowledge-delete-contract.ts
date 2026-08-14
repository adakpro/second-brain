export type KnowledgeDeleteTarget = {
  id: string;
  title: string;
  revision?: string;
  editable?: boolean;
  deletable?: boolean;
  source?: string;
  path?: string;
};

export type KnowledgeDeleteTargetSnapshot = {
  id: string;
  title: string;
  revision: string;
  editable: true;
  deletable: true;
  source: "vault";
  path?: string;
};

export type KnowledgeDeleteReceipt = {
  id: string;
  status: "trashed";
  recovery: "available";
  trashedPath: string;
  originalTrashed: boolean;
  indexState: "ready" | "pending";
};

export type KnowledgeDeleteFailure = {
  status: number;
  detail: string;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION = /^[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanOptionalPath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (
    !path
    || path.length > 4096
    || path.startsWith("/")
    || path.includes("\\")
    || /[\0\r\n]/.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) return undefined;
  return path;
}

export function canTrashKnowledgeTarget(target: KnowledgeDeleteTarget | null | undefined) {
  return Boolean(
    target
    && SAFE_ID.test(target.id)
    && target.title.trim()
    && target.title.length <= 240
    && target.editable === true
    && target.deletable === true
    && target.source === "vault"
    && typeof target.revision === "string"
    && REVISION.test(target.revision),
  );
}

export function snapshotKnowledgeDeleteTarget(
  target: KnowledgeDeleteTarget | null | undefined,
): KnowledgeDeleteTargetSnapshot | null {
  if (!canTrashKnowledgeTarget(target) || !target?.revision) return null;
  return Object.freeze({
    id: target.id,
    title: target.title,
    revision: target.revision,
    editable: true as const,
    deletable: true as const,
    source: "vault" as const,
    ...(target.path ? { path: target.path } : {}),
  });
}

export function parseKnowledgeDeleteReceipt(value: unknown): KnowledgeDeleteReceipt | null {
  const payload = record(value);
  if (!payload || payload.status !== "trashed" || payload.recovery !== "available") return null;
  if (typeof payload.id !== "string" || !SAFE_ID.test(payload.id)) return null;
  if (payload.index_state !== "ready" && payload.index_state !== "pending") return null;
  if (typeof payload.original_trashed !== "boolean") return null;

  const rawTrashedPath = payload.trashed_path;
  const trashedPath = cleanOptionalPath(rawTrashedPath);
  if (trashedPath === undefined) return null;

  return {
    id: payload.id,
    status: "trashed",
    recovery: "available",
    trashedPath,
    originalTrashed: payload.original_trashed,
    indexState: payload.index_state,
  };
}

export function parseKnowledgeDeleteFailure(status: number, value: unknown): KnowledgeDeleteFailure {
  const payload = record(value);
  const supplied = typeof payload?.detail === "string" ? payload.detail.trim() : "";
  const fallback = status === 409
    ? "This note changed after it was opened. Refresh it before moving it to Trash."
    : status === 403
      ? "Only editable notes in your vault can be moved to Trash."
      : status === 404
        ? "This note no longer exists. Refresh your knowledge view."
        : status === 429
          ? "Knowledge is busy. Retry in a moment."
          : status >= 500
            ? "Knowledge could not confirm the Trash operation. Nothing is shown as deleted."
            : "The note could not be moved to Trash.";

  return { status, detail: supplied.slice(0, 500) || fallback };
}
