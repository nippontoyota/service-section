"use client";

import { useEffect, useId, useRef } from "react";
import { FileText } from "lucide-react";

export function Brand() {
  return <div className="sd-brand"><span><FileText size={22} aria-hidden="true"/></span>Bill<span>Desk</span></div>;
}

export function AuthTransition({ action }: { action: "in" | "out" | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const node = dialog.current;
    if (action && node && !node.open) node.showModal();
    else if (!action) node?.close();
    return () => node?.close();
  }, [action]);
  return <dialog ref={dialog} className="sd-auth-transition" aria-labelledby={title} onCancel={event => event.preventDefault()}>
    <div className="sd-auth-content">
      <Brand/>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h1 id={title}>{action === "out" ? "Signing out…" : "Signing in…"}</h1>
        <p>{action === "out" ? "Closing your session securely." : "Getting your workspace ready."}</p>
      </div>
      <span className="sd-auth-progress" aria-hidden="true"><span/><span/><span/></span>
      <span className="sd-auth-caption">NIPPON TOYOTA · SERVICE WORKSPACE</span>
    </div>
  </dialog>;
}
