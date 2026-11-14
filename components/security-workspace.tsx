"use client";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./desk-brand";
import type QrScanner from "qr-scanner";
import { gateCodeFromLink, type GatePass } from "@/lib/gate-pass";
import { requestJson, RequestTimeoutError } from "@/lib/operation";
import { OperationDialog, OperationStatus, useOperation } from "./operation-feedback";
import "./service-desk.css";
import "./security-workspace.css";

export function SecurityWorkspace({ origin, code }: { origin: string; code?: string }) {
 const feedback = useOperation();
 const uncertain = useRef(false);
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
 const [signingOut, setSigningOut] = useState(false);
 const [logoutUncertain, setLogoutUncertain] = useState(false);
 const logoutLock = useRef(false);
 useEffect(() => () => { stopped.current = true; scanner.current?.destroy(); }, []);
 async function check(confirm = false) {
  if (!code || inFlight.current || (confirm && uncertain.current)) return;
  if (!feedback.begin(confirm ? "Confirming vehicle exit…" : "Verifying gate pass…", undefined, "inline")) return;
  inFlight.current = true; setBusy(true); setError(""); setPass(null);
  try {
   const result = await requestJson("/api/gate-passes/" + (confirm ? "confirm-exit" : "verify"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), cache: "no-store",
   }, confirm);
   uncertain.current = false;
   setPass(result); setConfirmed(Boolean(result.confirmed));
   const success = confirm ? result.confirmed === true : result.status === "Valid";
   await feedback.finish(success ? "success" : "failure", success ? confirm ? "Vehicle exit confirmed" : "Gate pass verified" : result.status || "Unable to verify", success ? undefined : "This pass does not authorize a new vehicle exit.");
  } catch (e) {
   if (e instanceof RequestTimeoutError && e.write) uncertain.current = true;
   const message = e instanceof RequestTimeoutError ? e.message : "Unable to verify—retry";
   setError(message); setConfirmed(false);
   await feedback.finish("failure", uncertain.current ? "Exit result uncertain" : "Unable to verify", message);
  } finally { inFlight.current = false; setBusy(false); }
 }
 useEffect(() => {
  if (!code) return;
  // Navigation verifies only; it can never confirm an exit.
  const timer = setTimeout(() => void check(), 0);
  return () => clearTimeout(timer);
  // Verification runs once for this route. Button retries use the same operation lock.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
 async function logout() {
  if (logoutLock.current || logoutUncertain) return;
  if (!feedback.begin("Signing out…")) return;
  logoutLock.current = true; setSigningOut(true); setError("");
  stopped.current = true; scanner.current?.stop(); setScanning(false);
  try {
   await requestJson("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
   await feedback.finish("success", "Signed out");
   window.location.assign("/");
  } catch (e) {
   const message = e instanceof Error ? e.message : "Could not sign out. Retry.";
   logoutLock.current = false; setSigningOut(false); setError(message);
   if (e instanceof RequestTimeoutError) setLogoutUncertain(true);
   await feedback.finish("failure", "Sign-out could not be confirmed", message);
  }
 }
 return <main className="sd-app gate-security"><OperationDialog operation={feedback.operation} onDismiss={feedback.dismiss}/><section className="gate-card"><OperationStatus operation={feedback.operation}/>
  <header><Brand/><button disabled={signingOut || logoutUncertain} onClick={() => void logout()}>Sign out</button></header>
  <p className="sd-eyebrow">SECURITY · VEHICLE EXIT</p><h1>{code ? "Check vehicle" : "Scan gate pass"}</h1>
  {error && <p role="alert" className="sd-warning">{error}</p>}
  {logoutUncertain && <button onClick={() => window.location.reload()}>Refresh status</button>}
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
