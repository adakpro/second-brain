"use client";

import { ArchiveRestore, CircleAlert, LoaderCircle, ShieldCheck, Trash2, X } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import {
  canTrashKnowledgeTarget,
  type KnowledgeDeleteReceipt,
  type KnowledgeDeleteTarget,
  type KnowledgeDeleteTargetSnapshot,
  parseKnowledgeDeleteFailure,
  parseKnowledgeDeleteReceipt,
  snapshotKnowledgeDeleteTarget,
} from "./knowledge-delete-contract";
import styles from "./knowledge-delete.module.css";

export interface KnowledgeDeleteButtonProps {
  target: KnowledgeDeleteTarget;
  live: boolean;
  className?: string;
  onDeleted: (receipt: KnowledgeDeleteReceipt) => void | Promise<void>;
  onConflictRefresh?: () => void | Promise<void>;
}

function useClientReady() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}

function useDialogFocus(
  open: boolean,
  locked: boolean,
  close: () => void,
  dialogRef: RefObject<HTMLDivElement | null>,
  initialRef: RefObject<HTMLButtonElement | null>,
) {
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    const inerted: Array<{ element: HTMLElement; inert: boolean }> = [];
    document.body.style.overflow = "hidden";

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
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const timer = window.setTimeout(() => (initialRef.current ?? focusable()[0] ?? dialog).focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!locked) {
          event.preventDefault();
          close();
        }
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
  }, [close, dialogRef, initialRef, locked, open]);
}

async function responsePayload(response: Response) {
  const value = await response.json().catch(() => null) as unknown;
  return value;
}

export function KnowledgeDeleteButton({
  target,
  live,
  className,
  onDeleted,
  onConflictRefresh,
}: KnowledgeDeleteButtonProps) {
  const clientReady = useClientReady();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshNotice, setRefreshNotice] = useState("");
  const [receipt, setReceipt] = useState<KnowledgeDeleteReceipt | null>(null);
  const [activeTarget, setActiveTarget] = useState<KnowledgeDeleteTargetSnapshot | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const eligible = canTrashKnowledgeTarget(target);

  const close = useCallback(() => {
    if (busy) return;
    setOpen(false);
    setError("");
    setRefreshNotice("");
    setReceipt(null);
    setActiveTarget(null);
  }, [busy]);
  useDialogFocus(open, busy, close, dialogRef, cancelRef);

  useEffect(() => () => requestRef.current?.abort(), []);

  const show = () => {
    const snapshot = snapshotKnowledgeDeleteTarget(target);
    if (!snapshot) return;
    setError("");
    setRefreshNotice("");
    setReceipt(null);
    setActiveTarget(snapshot);
    setOpen(true);
  };

  const moveToTrash = async () => {
    if (busy || !live || !activeTarget) return;
    const confirmedTarget = activeTarget;
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    setBusy(true);
    setError("");
    setRefreshNotice("");

    try {
      const response = await fetch(`/api/control/knowledge/nodes/${encodeURIComponent(confirmedTarget.id)}`, {
        method: "DELETE",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: confirmedTarget.revision }),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        const failure = parseKnowledgeDeleteFailure(response.status, payload);
        if (failure.status === 409) {
          if (onConflictRefresh) {
            try {
              await onConflictRefresh();
              setRefreshNotice("The current knowledge view was refreshed. Review the latest note, then try again.");
            } catch {
              setRefreshNotice("Automatic refresh failed. Close this dialog and reload Knowledge before retrying.");
            }
          } else {
            setRefreshNotice("Close this dialog and reload Knowledge before retrying.");
          }
        }
        setError(failure.detail);
        return;
      }

      const confirmed = parseKnowledgeDeleteReceipt(payload);
      if (!confirmed || confirmed.id !== confirmedTarget.id) {
        setError("Knowledge returned an invalid Trash confirmation. Refresh the vault before taking another action.");
        return;
      }

      setReceipt(confirmed);
      try {
        await onDeleted(confirmed);
      } catch {
        setRefreshNotice("The note is in recoverable Trash, but this screen could not refresh. Reload Knowledge to update the list and graph.");
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.name === "AbortError"
        ? "The Trash request timed out before confirmation. Refresh the vault before retrying."
        : "Knowledge is unavailable. No Trash operation was confirmed.");
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
      setBusy(false);
    }
  };

  const dialog = open && activeTarget ? (
    <div className={styles.backdrop}>
      <button
        type="button"
        className={styles.dismissLayer}
        aria-label="Close Move to Trash confirmation"
        onClick={close}
        disabled={busy}
      />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="knowledge-delete-title"
        aria-describedby="knowledge-delete-description"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <span className={styles.icon}><Trash2 size={20} /></span>
          <div>
            <small>Recoverable vault action</small>
            <h2 id="knowledge-delete-title">Move “{activeTarget.title}” to Trash?</h2>
          </div>
          <button type="button" className={styles.closeButton} onClick={close} disabled={busy} aria-label="Close"><X size={16} /></button>
        </header>

        {receipt ? (
          <div id="knowledge-delete-description" className={styles.success} role="status">
            <ArchiveRestore size={20} />
            <div>
              <strong>Moved to recoverable Trash</strong>
              <p>The Markdown note left the active vault and will disappear from refreshed items and graph.</p>
              {receipt.originalTrashed ? <p>Its retained imported original was also moved to private recovery storage.</p> : null}
              {receipt.indexState === "pending" ? <p>The file move is complete; the index refresh is still pending.</p> : null}
            </div>
          </div>
        ) : (
          <>
            <p id="knowledge-delete-description" className={styles.description}>
              This removes the Markdown note from the active vault and graph. The server moves it to private, recoverable Trash; it is not permanently erased.
            </p>
            <div className={styles.targetCard}>
              <strong>{activeTarget.title}</strong>
              {activeTarget.path ? <code>{activeTarget.path}</code> : null}
              <span><ShieldCheck size={13} /> Revision-checked before the move</span>
            </div>
          </>
        )}

        {error ? <div className={styles.alert} role="alert"><CircleAlert size={16} /><span>{error}</span></div> : null}
        {refreshNotice ? <div className={styles.notice} role="status"><ShieldCheck size={16} /><span>{refreshNotice}</span></div> : null}

        <footer className={styles.actions}>
          {receipt ? (
            <button ref={cancelRef} type="button" className={styles.quietButton} onClick={close}>Done</button>
          ) : (
            <>
              <button ref={cancelRef} type="button" className={styles.quietButton} onClick={close} disabled={busy}>Keep note</button>
              <button type="button" className={styles.trashButton} onClick={() => void moveToTrash()} disabled={busy || !live}>
                {busy ? <LoaderCircle className={styles.spin} size={15} /> : <Trash2 size={15} />}
                {busy ? "Moving…" : "Move to Trash"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <>
      {eligible ? (
        <button
          type="button"
          className={className ?? styles.trigger}
          onClick={show}
          disabled={!live}
          aria-label={`Move ${target.title} to Trash`}
          title={live ? "Move this vault note to recoverable Trash" : "Reconnect Knowledge before moving this note"}
        >
          <Trash2 size={15} />
          <span>Trash</span>
        </button>
      ) : null}
      {clientReady && dialog ? createPortal(dialog, document.body) : null}
    </>
  );
}
