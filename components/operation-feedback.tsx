"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { OperationState } from "@/lib/operation";
import { ToyotaEmblem } from "./desk-brand";

export function useOperation() {
  const [operation, setOperation] = useState<OperationState | null>(null);
  const lock = useRef(false);
  function begin(text: string, total?: number) {
    if (lock.current) return false;
    lock.current = true;
    setOperation({ outcome: "pending", text, ...(total === undefined ? {} : { completed: 0, total }) });
    return true;
  }
  function progress(text: string, completed?: number, total?: number) {
    setOperation({ outcome: "pending", text, completed, total });
  }
  async function finish(outcome: "success" | "failure", text: string, detail?: string) {
    setOperation({ outcome, text, detail });
    if (outcome === "success") {
      await new Promise(resolve => setTimeout(resolve, 800));
      setOperation(null);
    }
    lock.current = false;
  }
  return { operation, lock, begin, progress, finish, dismiss: () => setOperation(null) };
}

export function OperationDialog({ operation, onDismiss }: { operation: OperationState | null; onDismiss?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const previous = useRef<HTMLElement | null>(null);
  const parentDialog = useRef<HTMLDialogElement | null>(null);
  const [slow, setSlow] = useState(false);
  const outcome = operation?.outcome;
  useEffect(() => {
    const node = dialog.current;
    if (outcome && node && !node.open) {
      previous.current = document.activeElement as HTMLElement | null;
      parentDialog.current = previous.current?.closest("dialog") ?? null;
      node.showModal();
    }
    if (!outcome && node?.open) {
      node.close();
      if (previous.current?.isConnected) previous.current.focus();
      else if (parentDialog.current?.open) parentDialog.current.querySelector<HTMLButtonElement>(".sd-dialog-close")?.focus();
    }
  }, [outcome]);
  useEffect(() => () => dialog.current?.close(), []);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(outcome === "pending"), 15_000);
    return () => { clearTimeout(timer); setSlow(false); };
  }, [outcome]);
  return <dialog ref={dialog} tabIndex={-1} onKeyDown={event => { if (event.key === "Tab" && outcome !== "failure") { event.preventDefault(); dialog.current?.focus(); } }} className="sd-auth-transition sd-operation" data-outcome={outcome} aria-labelledby={title}
    onCancel={event => { event.preventDefault(); if (outcome === "failure") onDismiss?.(); }}>
    <div className="sd-auth-content">
      <ToyotaEmblem/>
      <div role={outcome === "failure" ? "alert" : "status"} aria-live="polite" aria-atomic="true">
        {outcome === "success" && <Check className="sd-operation-tick" size={44} aria-hidden="true"/>}
        {outcome === "failure" && <CircleAlert size={36} aria-hidden="true"/>}
        <h1 id={title}>{operation?.text}</h1>
        {operation?.total !== undefined && <p>{operation.completed} / {operation.total} completed</p>}
        {operation?.detail && <p>{operation.detail}</p>}
        {slow && outcome === "pending" && <p>Still processing… Keep this window open. We’ll show the result when the request finishes.</p>}
      </div>
      {outcome === "failure" && <button autoFocus className="sd-secondary" onClick={onDismiss}>Continue</button>}
      <span className="sd-auth-caption">NIPPON TOYOTA · SERVICE WORKSPACE</span>
    </div>
  </dialog>;
}
