"use client";
import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import type QrScanner from "qr-scanner";
import { gateCodeFromLink, type GatePass } from "@/lib/gate-pass";
import { readApiResponse } from "@/lib/api-response";
import "./service-desk.css";
import "./security-workspace.css";

export function SecurityWorkspace({ origin, code }: { origin: string; code?: string }) {
 const video = useRef<HTMLVideoElement>(null);
 const scanner = useRef<QrScanner | null>(null);
 const stopped = useRef(false);
 const inFlight = useRef(false);
 const [scanning, setScanning] = useState(false);
 const [link, setLink] = useState("");
 const [error, setError] = useState("");
 const [pass, setPass] = useState<GatePass | null>(null);
 const [busy, setBusy] = useState(Boolean(code));
 const [confirmed, setConfirmed] = useState(false);
 useEffect(() => () => { stopped.current = true; scanner.current?.destroy(); }, []);
 async function check(confirm = false) {
  if (!code || inFlight.current) return;
  inFlight.current = true; setBusy(true); setError(""); setPass(null);
  try {
   const response = await fetch("/api/gate-passes/" + (confirm ? "confirm-exit" : "verify"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), cache: "no-store",
   });
   const result = await readApiResponse(response);
   setPass(result); setConfirmed(Boolean(result.confirmed));
  } catch { setError("Unable to verify—retry"); setConfirmed(false); }
  finally { inFlight.current = false; setBusy(false); }
 }
 useEffect(() => {
  if (!code) return;
  // Verification only: neither navigation nor a repeated camera frame consumes a pass.
  let cancelled = false;
  inFlight.current = true;
  fetch("/api/gate-passes/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), cache: "no-store" })
   .then(readApiResponse).then(result => { if (!cancelled) setPass(result); })
   .catch(() => { if (!cancelled) setError("Unable to verify—retry"); })
   .finally(() => { if (!cancelled) { inFlight.current = false; setBusy(false); } });
  return () => { cancelled = true; };
 }, [code]);
 function accept(value: string) {
  scanner.current?.stop(); setScanning(false);
  const parsed = gateCodeFromLink(value, origin);
  if (!parsed) { setError("Invalid. Scan or paste a BillDesk gate-pass link."); return; }
  window.location.assign("/security/verify/" + parsed);
 }
 async function start() {
  setError(""); setScanning(true); stopped.current = false;
  try {
   const { default: Scanner } = await import("qr-scanner");
   if (stopped.current || !video.current) return;
   scanner.current?.destroy();
   let found = false;
   scanner.current = new Scanner(video.current, result => {
    if (found) return;
    found = true; accept(result.data);
   }, { preferredCamera: "environment", returnDetailedScanResult: true, highlightScanRegion: true });
   await scanner.current.start();
   if (stopped.current) scanner.current.destroy();
  } catch { scanner.current?.destroy(); scanner.current = null; setScanning(false); setError("Camera unavailable. Paste the customer's BillDesk gate-pass link below."); }
 }
 return <main className="sd-app gate-security"><section className="gate-card">
  <header><span className="sd-brand"><span><FileText size={22}/></span>Bill<span>Desk</span></span><button onClick={async () => {
   try { await readApiResponse(await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })); window.location.assign("/"); }
   catch { setError("Could not sign out. Retry."); }
  }}>Sign out</button></header>
  <p className="sd-eyebrow">SECURITY · VEHICLE EXIT</p><h1>{code ? "Check vehicle" : "Scan gate pass"}</h1>
  {error && <p role="alert" className="sd-warning">{error}</p>}
  {code ? <>
   {!pass && !error && <p role="status">Verifying…</p>}
   {pass && <div aria-live="polite">
    <p className={"gate-result " + (pass.status === "Valid" || confirmed ? "gate-valid" : "")}>{confirmed ? "Exit confirmed" : pass.status}</p>
    {pass.vehicle && <><h2 className="gate-registration">{pass.vehicle}</h2><p>{pass.customerName}</p><dl><dt>Issued by</dt><dd>{pass.issuer}</dd><dt>Expires</dt><dd>{new Date(pass.expiresAt!).toLocaleString("en-IN")}</dd>{pass.exitAt && <><dt>Exit recorded</dt><dd>{new Date(pass.exitAt).toLocaleString("en-IN")}</dd></>}</dl></>}
    {pass.status === "Valid" && !busy && <><p>Compare this registration with the physical vehicle before confirming.</p><button className="sd-primary" onClick={() => void check(true)}>Confirm exit</button></>}
   </div>}
   {!confirmed && <button disabled={busy} className="sd-secondary" onClick={() => void check()}>{busy ? "Checking…" : "Retry verification"}</button>}
   <a className="gate-next" href="/security">Scan next vehicle</a>
  </> : <>
   <p>Scan the customer’s QR code, then compare the vehicle before confirming exit.</p>
   <video ref={video} muted playsInline className={scanning ? "" : "gate-hidden"}/>
   <button className="sd-primary" disabled={scanning} onClick={() => void start()}>Scan QR</button>
   {scanning && <button onClick={() => { stopped.current = true; scanner.current?.stop(); setScanning(false); }}>Stop camera</button>}
   <form onSubmit={e => { e.preventDefault(); accept(link); }}><label>Or paste a gate-pass link<input type="url" required value={link} onChange={e => setLink(e.target.value)} placeholder={origin + "/g/…"}/></label><button className="sd-secondary">Verify link</button></form>
  </>}
 </section></main>;
}
