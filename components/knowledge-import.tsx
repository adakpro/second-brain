"use client";

import {
  Check,
  CircleAlert,
  CloudUpload,
  ExternalLink,
  FileCheck2,
  FileText,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  type ImportCapabilities,
  type KnowledgeImportBatch,
  type KnowledgeImportResult,
  normalizeImportCapabilities,
  notifyKnowledgeImported,
  parseKnowledgeImportBatch,
  reconcileImportResults,
} from "./knowledge-import-contract";
import styles from "./knowledge-import.module.css";

type QueueStatus =
  | "queued"
  | "uploading"
  | "extracting"
  | "imported"
  | "duplicate"
  | "failed"
  | "attention"
  | "uncertain";

type QueueEntry = {
  id: string;
  file: File;
  status: QueueStatus;
  detail: string;
  result?: KnowledgeImportResult;
};

export interface KnowledgeImportLauncherProps {
  live: boolean;
  vaultName?: string;
  className?: string;
  onImported?: (batch: KnowledgeImportBatch) => void | Promise<void>;
  onOpenKnowledge?: (id: string) => void;
}

const MAX_CLIENT_QUEUE = 80;

const statusLabels: Record<QueueStatus, string> = {
  queued: "Ready",
  uploading: "Uploading",
  extracting: "Extracting",
  imported: "Imported",
  duplicate: "Already in vault",
  failed: "Retry available",
  attention: "Needs attention",
  uncertain: "Verify or retry",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function humanBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function fileExtension(name: string) {
  const match = /(?:^|\/)([^/]+?)(\.[^.]+)$/.exec(name);
  return match?.[2]?.toLowerCase() ?? "";
}

function responseDetail(xhr: XMLHttpRequest) {
  try {
    const payload = JSON.parse(xhr.responseText) as unknown;
    if (isRecord(payload) && typeof payload.detail === "string" && payload.detail.trim()) return payload.detail.trim();
  } catch {
    // The BFF normally returns JSON, but a gateway can replace an error body.
  }
  return xhr.status === 0 ? "The server connection ended before a result was confirmed." : `Import failed (${xhr.status}).`;
}

function queueId(file: File) {
  return `${crypto.randomUUID()}:${file.name}:${file.size}:${file.lastModified}`;
}

function useModalFocus(open: boolean, locked: boolean, close: () => void, dialogRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const inerted: Array<{ element: HTMLElement; inert: boolean }> = [];
    // Keep the backdrop dismiss target usable; inert only content outside the
    // portal branch (normally the Next.js application root).
    let branch: HTMLElement | null = dialog.parentElement;
    while (branch?.parentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const sibling of [...parent.children]) {
        if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
        inerted.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      branch = parent;
      if (branch === document.body) break;
    }

    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute("aria-hidden"));
    const timer = window.setTimeout(() => (focusable()[0] ?? dialog).focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (!candidates.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = originalOverflow;
      inerted.forEach(({ element, inert }) => { element.inert = inert; });
      previous?.focus();
    };
  }, [close, dialogRef, locked, open]);
}

function EntryStatusIcon({ status }: { status: QueueStatus }) {
  if (status === "uploading" || status === "extracting") return <LoaderCircle className={styles.spin} size={15} />;
  if (status === "imported" || status === "duplicate") return <Check size={15} />;
  if (status === "failed" || status === "attention" || status === "uncertain") return <CircleAlert size={15} />;
  return <FileText size={15} />;
}

export function KnowledgeImportLauncher({
  live,
  vaultName = "Obsidian",
  className,
  onImported,
  onOpenKnowledge,
}: KnowledgeImportLauncherProps) {
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<ImportCapabilities | null>(null);
  const [capabilityState, setCapabilityState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [tags, setTags] = useState("");
  const [target, setTarget] = useState<"inbox" | "permanent">("inbox");
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ loaded: number; total?: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [indexState, setIndexState] = useState<"ready" | "pending" | undefined>();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const close = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);
  const show = () => {
    setCapabilityState("loading");
    setCapabilities(null);
    setError("");
    setOpen(true);
  };
  useModalFocus(open, busy, close, dialogRef);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/control/knowledge/import", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const detail = isRecord(payload) && typeof payload.detail === "string" ? payload.detail : "Import capabilities are unavailable.";
        throw new Error(detail);
      }
      const normalized = normalizeImportCapabilities(payload);
      if (!normalized) throw new Error("The server returned an invalid import capability contract.");
      setCapabilities(normalized);
      setCapabilityState("ready");
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setCapabilityState("error");
      setError(cause instanceof Error ? cause.message : "Import capabilities are unavailable.");
    });
    return () => controller.abort();
  }, [open]);

  useEffect(() => () => xhrRef.current?.abort(), []);

  const accept = useMemo(() => capabilities
    ? [...capabilities.extensions, ...capabilities.mediaTypes].join(",")
    : undefined, [capabilities]);
  const pending = useMemo(() => queue.filter((entry) => ["queued", "failed", "uncertain"].includes(entry.status)), [queue]);
  const completedCount = queue.filter((entry) => entry.status === "imported" || entry.status === "duplicate").length;

  const validateFile = useCallback((file: File) => {
    if (!capabilities) return "Server capabilities have not loaded.";
    if (file.size > capabilities.maxFileBytes) return `Maximum per file is ${humanBytes(capabilities.maxFileBytes)}.`;
    const extension = fileExtension(file.name);
    if (!extension || !capabilities.extensions.includes(extension)) return `${extension || "This file"} is not in the server’s accepted extension list.`;
    return "";
  }, [capabilities]);

  const addFiles = useCallback((files: File[]) => {
    if (!capabilities || busy) return;
    setError("");
    setNotice("");
    setQueue((current) => {
      const room = Math.max(0, MAX_CLIENT_QUEUE - current.length);
      const accepted = files.slice(0, room).map((file): QueueEntry => {
        const validation = validateFile(file);
        return {
          id: queueId(file),
          file,
          status: validation ? "attention" : "queued",
          detail: validation || "Ready for server validation",
        };
      });
      if (files.length > room) setError(`This panel keeps at most ${MAX_CLIENT_QUEUE} queued records at once.`);
      return [...current, ...accepted];
    });
  }, [busy, capabilities, validateFile]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (capabilityState === "ready") addFiles([...event.dataTransfer.files]);
  };

  const markBatch = useCallback((ids: Set<string>, status: QueueStatus, detail: string) => {
    setQueue((current) => current.map((entry) => ids.has(entry.id) ? { ...entry, status, detail } : entry));
  }, []);

  const upload = useCallback(() => {
    if (!capabilities || busy) return;
    const candidates = queue.filter((entry) => ["queued", "failed", "uncertain"].includes(entry.status));
    if (!candidates.length) return;
    if (candidates.length > capabilities.maxFiles) {
      setError(`Send at most ${capabilities.maxFiles} files per batch. Remove or finish some queued files first.`);
      return;
    }
    const totalFileBytes = candidates.reduce((sum, entry) => sum + entry.file.size, 0);
    if (totalFileBytes > capabilities.maxTotalBytes) {
      setError(`This batch is ${humanBytes(totalFileBytes)}; the server limit is ${humanBytes(capabilities.maxTotalBytes)}.`);
      return;
    }

    const sentIds = new Set(candidates.map((entry) => entry.id));
    const form = new FormData();
    candidates.forEach((entry) => form.append("files", entry.file, entry.file.name));
    const cleanedTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean).join(",");
    if (cleanedTags) form.set("tags", cleanedTags);
    form.set("target", target);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    setBusy(true);
    setError("");
    setNotice("");
    setIndexState(undefined);
    setBatchProgress({ loaded: 0 });
    markBatch(sentIds, "uploading", "Sending bytes to this HERMESS server");

    xhr.open("POST", "/api/control/knowledge/import");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      setBatchProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : undefined });
    };
    xhr.upload.onload = () => {
      markBatch(sentIds, "extracting", "Server is validating, extracting, and committing Markdown");
    };
    xhr.onload = () => {
      xhrRef.current = null;
      setBusy(false);
      setBatchProgress(null);
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail = responseDetail(xhr);
        markBatch(sentIds, "failed", detail);
        setError(detail);
        return;
      }

      let payload: unknown = null;
      try { payload = JSON.parse(xhr.responseText) as unknown; } catch { /* handled below */ }
      const batch = parseKnowledgeImportBatch(payload);
      if (!batch || batch.results.length !== candidates.length) {
        const detail = "The server response did not match the submitted batch. Verify the vault before retrying.";
        markBatch(sentIds, "uncertain", detail);
        setError(detail);
        return;
      }

      const reconciliation = reconcileImportResults(
        candidates.map((entry) => ({ id: entry.id, filename: entry.file.name })),
        batch.results,
      );
      if (!reconciliation) {
        const detail = "The server response could not be reconciled with this batch. Verify the vault before retrying.";
        markBatch(sentIds, "uncertain", detail);
        setError(detail);
        return;
      }
      setQueue((current) => current.map((entry) => {
        if (!sentIds.has(entry.id)) return entry;
        const result = reconciliation.get(entry.id);
        if (!result) return { ...entry, status: "uncertain", detail: "No per-file result was returned." };
        return {
          ...entry,
          status: result.status,
          result,
          detail: result.status === "duplicate"
            ? "Identical content already exists; no second note was created"
            : `Extracted with ${result.extractor || "the server extractor"}`,
        };
      }));
      setIndexState(batch.index_state);
      const imported = batch.results.filter((result) => result.status === "imported").length;
      const duplicates = batch.results.filter((result) => result.status === "duplicate").length;
      setNotice(`${imported} imported${duplicates ? ` · ${duplicates} already present` : ""}.`);
      void notifyKnowledgeImported(batch, onImported).catch(() => undefined);
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setBusy(false);
      setBatchProgress(null);
      const detail = "The connection ended without a confirmed result. SHA-256 retry is safe; verify the vault or retry.";
      markBatch(sentIds, "uncertain", detail);
      setError(detail);
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      setBusy(false);
      setBatchProgress(null);
      const detail = "Upload cancelled without a confirmed result. SHA-256 retry is safe; the server will report an existing duplicate.";
      markBatch(sentIds, "uncertain", detail);
      setNotice(detail);
    };
    xhr.send(form);
  }, [busy, capabilities, markBatch, onImported, queue, tags, target]);

  const cancelUpload = () => xhrRef.current?.abort();
  const removeEntry = (id: string) => setQueue((current) => current.filter((entry) => entry.id !== id));
  const clearFinished = () => setQueue((current) => current.filter((entry) => !["imported", "duplicate"].includes(entry.status)));
  const dropKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.key === "Enter" || event.key === " ") && capabilityState === "ready" && !busy) {
      event.preventDefault();
      inputRef.current?.click();
    }
  };

  const modal = open ? (
    <div className={styles.backdrop}>
      <button type="button" className={styles.dismissLayer} onClick={close} disabled={busy} aria-label="Close knowledge import" />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="knowledge-import-title"
        aria-describedby="knowledge-import-description"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.titleMark}><CloudUpload size={21} /></div>
          <div>
            <span>Private knowledge pipeline</span>
            <h2 id="knowledge-import-title">Import into {vaultName}</h2>
          </div>
          <button type="button" className={styles.iconButton} onClick={close} disabled={busy} aria-label="Close knowledge import"><X size={17} /></button>
        </header>

        <p id="knowledge-import-description" className={styles.intro}>
          Add source files, let the local knowledge service extract them into Obsidian-compatible Markdown, then index only the committed notes.
        </p>

        <div className={styles.safetyStrip}>
          <LockKeyhole size={16} />
          <span><strong>Private ingestion.</strong> Raw uploads and extraction stay on this HERMESS server. Indexed excerpts may later be shared with your configured AI only when you use Solari or brain search. Source name, media type, SHA-256 and extractor remain attached as provenance.</span>
        </div>

        {capabilityState === "loading" ? <div className={styles.loadingCapabilities}><LoaderCircle className={styles.spin} size={17} /> Reading server limits…</div> : null}
        {capabilityState === "error" ? <div className={styles.alert} role="alert"><CircleAlert size={16} /><span>{error}</span><button type="button" onClick={() => setOpen(false)}>Close</button></div> : null}

        {capabilities ? (
          <>
            <div
              className={`${styles.dropZone} ${dragActive ? styles.dropActive : ""}`}
              onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragActive(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
              onDrop={handleDrop}
              onKeyDown={dropKey}
              onClick={() => { if (!busy) inputRef.current?.click(); }}
              role="button"
              tabIndex={busy ? -1 : 0}
              aria-disabled={busy}
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={accept}
                onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }}
                tabIndex={-1}
                aria-hidden="true"
              />
              <span className={styles.dropIcon}><CloudUpload size={24} /></span>
              <strong>Drop files here or choose from your device</strong>
              <small>{capabilities.extensions.map((item) => item.slice(1).toUpperCase()).join(" · ")}</small>
              <em>Up to {capabilities.maxFiles} files · {humanBytes(capabilities.maxFileBytes)} each · {humanBytes(capabilities.maxTotalBytes)} per batch</em>
            </div>

            <div className={styles.policyGrid}>
              <label>
                <span>Destination</span>
                <select value={target} onChange={(event) => setTarget(event.target.value as "inbox" | "permanent")} disabled={busy}>
                  <option value="inbox">Inbox · review first</option>
                  <option value="permanent">Permanent notes</option>
                </select>
              </label>
              <label>
                <span>Tags · optional, comma separated</span>
                <input value={tags} onChange={(event) => setTags(event.target.value)} maxLength={500} placeholder="research, client-a" disabled={busy} />
              </label>
            </div>

            <div className={styles.conflictPolicy}>
              <ShieldCheck size={15} />
              <span><strong>Safe-copy policy:</strong> files are never blindly overwritten. Identical bytes resolve to the existing note; a reused filename with different content becomes a versioned note. The full batch becomes visible only after every extraction and private original is durable; retries are content-hash idempotent.{capabilities.extensions.includes(".png") ? " Images and scanned PDFs use local Persian + English OCR." : ""}{capabilities.malwareScan === false ? " No malware scanner is configured, so import only files you trust." : capabilities.malwareScan === null ? " Malware scanning is not claimed by this server, so import only files you trust." : " The server reports malware scanning enabled."}</span>
            </div>

            {queue.length ? (
              <section className={styles.queue} aria-labelledby="import-queue-title">
                <div className={styles.queueHeader}>
                  <div><h3 id="import-queue-title">Import queue</h3><span>{queue.length} files · {humanBytes(queue.reduce((sum, entry) => sum + entry.file.size, 0))}</span></div>
                  {completedCount && !busy ? <button type="button" onClick={clearFinished}><Trash2 size={13} /> Clear finished</button> : null}
                </div>
                {batchProgress ? (
                  <div className={styles.batchProgress} aria-live="polite">
                    <div><span>Batch upload</span><span>{batchProgress.total ? `${Math.min(100, Math.round(batchProgress.loaded / batchProgress.total * 100))}%` : humanBytes(batchProgress.loaded)}</span></div>
                    <progress {...(batchProgress.total ? { value: batchProgress.loaded, max: batchProgress.total } : {})} aria-label="Batch upload progress" />
                  </div>
                ) : null}
                <div className={styles.queueList} aria-live="polite">
                  {queue.map((entry) => (
                    <article key={entry.id} className={`${styles.queueItem} ${styles[`status_${entry.status}`]}`}>
                      <span className={styles.statusIcon}><EntryStatusIcon status={entry.status} /></span>
                      <div className={styles.fileCopy}>
                        <strong title={entry.file.name}>{entry.file.name}</strong>
                        <span>{humanBytes(entry.file.size)} · {entry.file.type || fileExtension(entry.file.name).slice(1).toUpperCase() || "unknown type"}</span>
                        <small>{entry.detail}</small>
                        {entry.result?.sha256 ? <code title={entry.result.sha256}>sha256:{entry.result.sha256.slice(0, 12)}…</code> : null}
                      </div>
                      <div className={styles.itemActions}>
                        <span>{statusLabels[entry.status]}</span>
                        {entry.result?.node?.id && onOpenKnowledge ? <button type="button" onClick={() => onOpenKnowledge(entry.result?.node?.id ?? "")}>Open note</button> : null}
                        {entry.result?.node?.obsidian_uri ? <a href={entry.result.node.obsidian_uri} aria-label={`Open ${entry.file.name} in Obsidian`}><ExternalLink size={14} /></a> : null}
                        {!busy && !["uploading", "extracting"].includes(entry.status) ? <button type="button" className={styles.removeButton} onClick={() => removeEntry(entry.id)} aria-label={`Remove ${entry.file.name}`}><X size={14} /></button> : null}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : <div className={styles.emptyQueue}><FileCheck2 size={18} /><span>Your files stay uncommitted until the server confirms the batch.</span></div>}

            {error && capabilityState !== "error" ? <div className={styles.alert} role="alert"><CircleAlert size={16} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={13} /></button></div> : null}
            {notice ? <div className={styles.notice} role="status"><Check size={16} /><span>{notice}{indexState === "pending" ? " Markdown is durable; indexing is still pending." : ""}</span></div> : null}

            <footer className={styles.footer}>
              <span>Client checks improve feedback; the server remains authoritative for type, size, extraction and commit.</span>
              <div>
                {busy ? <button type="button" className={styles.quietButton} onClick={cancelUpload}><X size={14} /> Cancel upload</button> : <button type="button" className={styles.quietButton} onClick={close}>Done</button>}
                <button type="button" className={styles.primaryButton} onClick={upload} disabled={busy || !pending.length}>
                  {busy ? <><LoaderCircle className={styles.spin} size={15} /> Extracting…</> : pending.some((entry) => entry.status === "failed" || entry.status === "uncertain") ? <><RotateCcw size={15} /> Retry safe batch</> : <><CloudUpload size={15} /> Import {pending.length || ""}</>}
                </button>
              </div>
            </footer>
          </>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={`${styles.launchButton} ${className ?? ""}`}
        onClick={show}
        disabled={!live}
        title={!live ? "Reconnect the knowledge vault before importing files" : "Import files into the private Obsidian vault"}
      >
        <CloudUpload size={15} /> Import files
      </button>
      {typeof document !== "undefined" && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
