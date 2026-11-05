"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { ArrowUpRight, Check, ChevronRight, FileText, LayoutDashboard, LogOut, Search, ShieldCheck, Upload, Users, X } from "lucide-react";
import { billAmount, billType, isSupportingNote, customerKey, groupCustomers, isPaid, indiaDate, money, report, type DeskBill, type Metric, type Snapshot, type Staff } from "@/lib/desk";
import { DEMO_KEY, demoAccounts, demoAction, demoPdf, freshDemo, upgradeDemo } from "@/lib/desk-demo";
import type { ExtractedBill } from "@/lib/pdf/extract";
import { importReferenceBills, isBuiltInSample } from "@/lib/import-reference-bills";
import "./service-desk.css";

const labels = { cashier: "Cashier", service_advisor: "Service advisor", super_admin: "Super admin" };
const metricNames = { billed: "Service bill value", collections: "Collected in full", outstanding: "Unpaid bill value", pending: "Awaiting approval" };
const dateTime = (date: string) => new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const empty: Snapshot = { bills: [], payments: [], staff: [], audit: [], as_of: "" };
type ActionBody = { action: string; target?: string; reason?: string; [key: string]: unknown };
const readDemo = (): Snapshot => {
  const stored = JSON.parse(localStorage.getItem(DEMO_KEY) || "null") ?? freshDemo();
  const upgraded = upgradeDemo(stored);
  if (upgraded !== stored) localStorage.setItem(DEMO_KEY,JSON.stringify(upgraded));
  return upgraded;
};

export function ServiceDesk({ demo, ready }: { demo: boolean; ready: boolean }) {
  const [profile, setProfile] = useState<Staff | null>(null);
  const [data, setData] = useState<Snapshot>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState(demo ? "bills" : "overview");
  const [metric, setMetric] = useState<Metric>("billed");
  const [query, setQuery] = useState("");
  const [customerFilter, setCustomerFilter] = useState<string | null>(null);
  const [from, setFrom] = useState(demo ? "" : indiaDate().slice(0,7) + "-01");
  const [to, setTo] = useState(demo ? "" : indiaDate());
  const [advisor, setAdvisor] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [preview, setPreview] = useState<DeskBill[]>([]);
  const [staffPassword, setStaffPassword] = useState("");

  const api = useCallback(async (url: string, body?: unknown) => {
    const response = await fetch(url, { method: body ? "POST" : "GET", credentials: "same-origin", headers: {
      "Content-Type": "application/json",
    }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    return result;
  }, []);
  const refresh = useCallback(async () => {
    if (demo) {
      const response = await fetch("/api/demo/reference-bills");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const current = readDemo();
      if (current.bills.some(isBuiltInSample) && !localStorage.getItem("service-desk-before-reference-import")) {
        localStorage.setItem("service-desk-before-reference-import",JSON.stringify(current));
      }
      const snapshot = importReferenceBills(current,result.bills);
      localStorage.setItem(DEMO_KEY,JSON.stringify(snapshot));
      const id = sessionStorage.getItem("desk-demo-user");
      const user = snapshot.staff.find(p => p.id === id && p.active) ?? null;
      setData(snapshot); setProfile(user);
    } else if (ready) {
      const response = await fetch("/api/desk", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { setProfile(null); setData(empty); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load workspace");
      setProfile(result.profile); if (result.snapshot) setData(result.snapshot);
    }
  }, [demo, ready]);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh().catch(e => setNotice(e.message)).finally(() => setLoading(false)), 0);
    const listener = () => void refresh().catch(e => { setNotice(e.message); setProfile(null); });
    window.addEventListener("storage", listener);
    const timer = window.setInterval(listener, 30000);
    return () => { window.clearTimeout(initial); window.removeEventListener("storage", listener); window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => () => { if (pdfUrl.startsWith("blob:")) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  function save(snapshot: Snapshot) { localStorage.setItem(DEMO_KEY, JSON.stringify(snapshot)); setData(snapshot); }
  async function perform(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await task(); } catch (e) { setNotice(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      const staffId = String(form.get("staffId")).trim().toLowerCase();
      const password = String(form.get("password"));
      if (demo) {
        const snapshot = readDemo();
        const overrides = JSON.parse(localStorage.getItem("desk-demo-passwords") || "{}");
        const account = snapshot.staff.find(p => p.staff_id === staffId && p.active);
        const expected = overrides[staffId] ?? demoAccounts.find(p => p.staff_id === staffId)?.password;
        if (!account || expected !== password) throw new Error("Invalid user ID or password");
        sessionStorage.setItem("desk-demo-user", account.id);
        save(snapshot); setProfile(account);
      } else {
        await api("/api/auth/login", { staffId, password });
        await refresh();
      }
      setTab(demo ? "bills" : "overview"); setMetric("billed"); setCustomerFilter(null);
    });
  }
  async function logout() {
    if (!demo) {
      try { await api("/api/auth/logout", {}); }
      catch (e) { setNotice(e instanceof Error ? e.message : "Could not sign out"); return; }
    }
    sessionStorage.removeItem("desk-demo-user"); setProfile(null); setData(empty); setSelectedId(null); setPreview([]); setNotice(""); setStaffPassword("");
  }
  async function action(body: ActionBody) {
    if (!profile) return;
    await perform(async () => {
      if (demo) {
        const snapshot = readDemo();
        const current = snapshot.staff.find(p => p.id === profile.id);
        if (!current?.active) throw new Error("Account disabled");
        if (["approve","collect","reverse"].includes(body.action)) save(demoAction(snapshot, current, body.action, body.target!, body.reason));
        else if (body.action === "password") {
          if (String(body.password).length < 12) throw new Error("Use at least 12 characters");
          const passwords = JSON.parse(localStorage.getItem("desk-demo-passwords") || "{}");
          passwords[profile.staff_id] = body.password;
          localStorage.setItem("desk-demo-passwords", JSON.stringify(passwords));
          current.must_change_password = false; save(snapshot); setProfile({ ...current });
        } else {
          if (current.role !== "super_admin") throw new Error("Super admin required");
          const passwords = JSON.parse(localStorage.getItem("desk-demo-passwords") || "{}");
          let target = snapshot.staff.find(p => p.id === body.target);
          if (body.action === "create_staff") {
            if (snapshot.staff.some(p => p.staff_id === body.staffId)) throw new Error("User ID already exists");
            target = { id: crypto.randomUUID(), staff_id: String(body.staffId), full_name: String(body.fullName), role: body.role as Staff["role"], active: true, must_change_password: true };
            snapshot.staff.push(target);
          }
          if (!target || target.id === current.id) throw new Error("Select another staff account");
          if (body.action === "toggle_staff") target.active = Boolean(body.active);
          else {
            const password = "Demo!" + crypto.randomUUID().slice(0,16);
            passwords[target.staff_id] = password; target.must_change_password = true;
            localStorage.setItem("desk-demo-passwords", JSON.stringify(passwords)); setStaffPassword(target.staff_id + " · " + password);
          }
          snapshot.audit.unshift({ id: crypto.randomUUID(), bill_id: null, actor_id: current.id, action: body.action, created_at: new Date().toISOString(), detail: { target: target.id } });
          save(snapshot);
        }
      } else {
        const result = await api("/api/desk", body);
        if (result.temporaryPassword) setStaffPassword("Temporary password: " + result.temporaryPassword);
        await refresh();
      }
      setNotice("Saved successfully.");
    });
  }
  async function upload(file: File) {
    if (!profile) return;
    await perform(async () => {
      if (!file.name.toLowerCase().endsWith(".pdf") || file.size > 10 * 1024 * 1024) throw new Error("Choose a PDF up to 10 MB");
      if (demo) {
        const form = new FormData(); form.set("file", file);
        const response = await fetch("/api/demo/extract", { method: "POST", body: form });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        const snapshot = readDemo();
        if (snapshot.bills.some(b => b.uploads?.file_hash === result.hash)) throw new Error("This PDF has already been uploaded");
        const uploadId = crypto.randomUUID();
        await demoPdf(uploadId, file);
        setPreview(result.bills.map((b: ExtractedBill) => ({
          id: crypto.randomUUID(), upload_id: uploadId, customer_name: b.customerName, vehicle_no_display: b.vehicleNo, vin: b.vin,
          customer_reference: b.customerReference || null,
          job_card_reference: b.jobCardReference || null, field_confidence: { ...b.confidence, document: b.document },
          invoice_reference: b.invoiceReference || null, invoice_date: b.invoiceDate, amount_paise: b.amountPaise,
          amount_evidence: b.amountEvidence, payment_evidence: b.paymentEvidence, extraction_issues: b.extractionIssues,
          page_from: b.pageFrom, page_to: b.pageTo, uploaded_by: profile.id, created_at: new Date().toISOString(),
          approved_at: null, approved_by: null, approval_status: "pending", status: "needs_review",
          uploads: { original_filename: file.name, confirmed_at: null, file_hash: result.hash },
        })));
      } else {
        const init = await api("/api/uploads/init", { filename: file.name, size: file.size, type: "application/pdf" });
        const uploaded = await fetch(init.signedUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
        if (!uploaded.ok) throw new Error("PDF upload failed. Please try again.");
        const result = await api("/api/uploads/" + init.uploadId + "/process", {});
        setPreview(result.bills);
      }
      setNotice("PDF read. Review the extracted details below, then submit to the cashier.");
    });
  }
  async function submit() {
    await perform(async () => {
      if (!preview.length || !profile) return;
      if (demo) {
        const snapshot = readDemo();
        const now = new Date().toISOString();
        if (snapshot.bills.some(b => b.uploads?.file_hash === preview[0].uploads?.file_hash)) throw new Error("This PDF has already been submitted");
        preview.forEach(b => {
          snapshot.bills.unshift({ ...b, customer_id: "demo-customer:" + customerKey(b), uploads: { ...b.uploads!, confirmed_at: now } });
          snapshot.audit.unshift({ id: crypto.randomUUID(), bill_id: b.id, actor_id: profile.id, action: "submitted", created_at: now, detail: {} });
        });
        save(snapshot);
      } else { await api("/api/uploads/" + preview[0].upload_id + "/confirm", {}); await refresh(); }
      setPreview([]); setNotice("Submitted. The cashier can now review and approve this bill.");
    });
  }
  async function openPdf(bill: DeskBill) {
    await perform(async () => {
      if (demo) {
        if (bill.reference_file) {
          setPdfUrl("/api/demo/reference-bills?file=" + encodeURIComponent(bill.reference_file));
          return;
        }
        const blob = await demoPdf(bill.upload_id);
        if (!blob) throw new Error("This PDF is not stored in this browser. Please upload the original again.");
        setPdfUrl(URL.createObjectURL(blob));
      } else setPdfUrl((await api("/api/desk", { action: "pdf", target: bill.id })).url);
    });
  }

  if (loading) return <div className="sd-loading">Opening BillDesk…</div>;
  if (!profile) return <div className="sd-login">
    <section className="sd-login-story" aria-labelledby="sd-login-title">
      <header className="sd-login-brand"><div className="sd-nippon-wordmark"><svg className="sd-toyota-emblem" viewBox="0 0 64 44" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><ellipse cx="32" cy="22" rx="29" ry="19"/><ellipse cx="32" cy="22" rx="10" ry="19"/><ellipse cx="32" cy="13" rx="25" ry="10"/></svg><div>NIPPON <span>TOYOTA</span></div></div><span className="sd-portal-label">SERVICE PORTAL</span></header>
      <div className="sd-login-intro"><span className="sd-eyebrow">CARE THAT GOES THE EXTRA MILE</span><h1 id="sd-login-title">Great service.<br /><span>Starts here.</span></h1><p>From the service bay to the counter.<br />Every bill. Every detail. In one place.</p></div>
      <div className="sd-fortuner-stage">
        <div className="sd-fortuner-backdrop" aria-hidden="true" />
        <Image className="sd-fortuner-image" src="/images/toyota-fortuner.png" alt="Pearl white Toyota Fortuner in a front three-quarter view" width={1536} height={1024} sizes="(max-width: 760px) 100vw, 60vw" priority />
        <div className="sd-fortuner-caption"><span>TOYOTA</span><strong>Fortuner.</strong></div>
        <span className="sd-fortuner-detail">Built for the journey.<br />Cared for by Nippon.</span>
      </div>
    </section>
    <section className="sd-login-panel"><div className="sd-login-card"><div className="sd-login-product"><Brand /><span>THE SERVICE WORKSPACE</span></div><span className="sd-eyebrow">{demo ? "LOCAL PDF TESTING · DEMO ACCOUNTS" : "NIPPON TOYOTA · STAFF ACCESS"}</span><h2>Welcome to your desk.</h2><p>Sign in with your individual staff account.</p>
      {!demo && !ready ? <p className="sd-alert">Staff login needs Supabase configuration. Follow the setup instructions in README.md.</p> : <form onSubmit={login}>
        <label>User ID<input name="staffId" placeholder="e.g. cashier01" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="sd-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<ArrowUpRight size={18}/></button>
      </form>}
      {notice && <p role="alert" className="sd-alert">{notice}</p>}
      {demo && <div className="sd-demo-accounts"><strong>Try a workspace</strong>{demoAccounts.map(p => <div key={p.id}><span>{labels[p.role]}<b>{p.staff_id}</b></span><code>{p.password}</code></div>)}<small>Local test accounts. The three supplied PDFs load automatically; workflow changes stay in this browser.</small></div>}
      <small className="sd-muted">Need access? Contact your centre administrator.</small>
    </div></section>
  </div>;

  if (profile.must_change_password) return <div className="sd-loading"><div className="sd-password"><Brand/><h1>Set your own password.</h1><p>Your temporary password must be changed before you can access bills.</p><form onSubmit={e => { e.preventDefault(); void action({ action: "password", password: new FormData(e.currentTarget).get("password") }); }}><label>New password<input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password"/></label><button className="sd-primary" disabled={busy}>Save password</button></form><p role="status">{notice}</p><button className="sd-plain" onClick={() => void logout()}>Sign out</button></div></div>;

  const visible: Snapshot = profile.role === "service_advisor" ? { ...data, bills: data.bills.filter(b => b.uploaded_by === profile.id) } : data;
  const summary = report(visible, from, to, advisor);
  const selected = data.bills.find(b => b.id === selectedId);
  const person = (id: string | null) => data.staff.find(p => p.id === id)?.full_name ?? "Staff member";
  const billState = (b: DeskBill) => !b.uploads?.confirmed_at ? "Draft" : isSupportingNote(b) ? "Supporting note" : b.approval_status !== "approved" ? "Awaiting approval" : isPaid(b, data.payments) ? "Paid in full" : "Unpaid";
  const list = tab === "bills" || profile.role === "service_advisor" ? visible.bills : metric === "collections" ? summary.payments.map(p => data.bills.find(b => b.id === p.bill_id)!).filter(Boolean) : metric === "billed" ? summary.billed : metric === "pending" ? summary.pending : summary.outstanding;
  const matches = (b: DeskBill) => (!customerFilter || (b.customer_id || customerKey(b)) === customerFilter) && [b.customer_name,b.customer_reference,b.vehicle_no_display,b.vin,b.invoice_reference,b.job_card_reference,billType(b),b.field_confidence?.document?.billedTo].some(v => v?.toLowerCase().includes(query.toLowerCase()));
  const rows = [...new Map(list.filter(matches).map(b => [b.id,b])).values()];
  const groups = new Map<string, number>();
  summary.payments.forEach(p => { const day = indiaDate(p.occurred_at); groups.set(day, (groups.get(day) ?? 0) + p.amount_paise); });
  const customerGroups = groupCustomers(rows);
  const selectedGroup = selected ? groupCustomers(visible.bills).find(g => g.id === (selected.customer_id || customerKey(selected))) : undefined;

  return <div className="sd-app">
    <aside className="sd-sidebar"><Brand/><span className="sd-eyebrow">{labels[profile.role]} WORKSPACE</span><nav>
      <button aria-current={tab === "overview" ? "page" : undefined} onClick={() => { setTab("overview"); setQuery(""); setCustomerFilter(null); }}><LayoutDashboard size={19}/>{profile.role === "service_advisor" ? "Upload & my bills" : "Overview"}</button>
      <button aria-current={tab === "bills" ? "page" : undefined} onClick={() => { setTab("bills"); setQuery(""); setCustomerFilter(null); }}><FileText size={19}/>Bill archive<span>{visible.bills.length}</span></button>
      {profile.role === "super_admin" && <><button aria-current={tab === "staff" ? "page" : undefined} onClick={() => setTab("staff")}><Users size={19}/>Staff accounts</button><button aria-current={tab === "activity" ? "page" : undefined} onClick={() => setTab("activity")}><ShieldCheck size={19}/>Activity log</button></>}
    </nav><div className="sd-sidebar-bottom"><span className="sd-retained"><ShieldCheck size={18}/>Permanent bill history</span><strong>{profile.full_name}</strong><small>{profile.staff_id} · {labels[profile.role]}</small><button className="sd-plain" onClick={() => void logout()}><LogOut size={16}/>Sign out</button></div></aside>
    <main className="sd-main">
      {demo && <div className="sd-demo-banner">LOCAL PDF WORKSPACE <span>Supplied PDFs and local uploads · no Supabase connection</span></div>}
      <header className="sd-header"><div><span className="sd-eyebrow">BILLDESK / {labels[profile.role].toUpperCase()}</span><h1>{tab === "staff" ? "Your people. Their access." : tab === "activity" ? "A record of every action." : tab === "bills" ? "The bill archive." : profile.role === "service_advisor" ? "Send bills to the counter." : profile.role === "super_admin" ? "The numbers, with the receipts." : "Keep the counter moving."}</h1><p>{profile.role === "service_advisor" ? "Choose a PDF. Amounts and details are read automatically." : "Open any total to see exactly which bills and payments make it up."}</p></div><button className="sd-secondary" disabled={busy} onClick={() => void perform(refresh)}>Refresh</button></header>
      {notice && <div className="sd-notice" role="status">{notice}<button aria-label="Dismiss message" onClick={() => setNotice("")}><X size={16}/></button></div>}
      {tab === "staff" && profile.role === "super_admin" ? <section className="sd-panel">
        <h2>Create a staff account</h2><form className="sd-staff-form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void action({ action: "create_staff", staffId: f.get("staffId"), fullName: f.get("fullName"), role: f.get("role") }); }}>
          <label>Full name<input name="fullName" maxLength={100} required/></label><label>User ID<input name="staffId" pattern="[a-z0-9_]{3,40}" title="3–40 lowercase letters, numbers or underscores" required/></label><label>Role<select name="role"><option value="service_advisor">Service advisor</option><option value="cashier">Cashier</option><option value="super_admin">Super admin</option></select></label><button className="sd-primary" disabled={busy}>Create account</button>
        </form>{staffPassword && <div className="sd-alert"><strong>Share privately; shown for this session only.</strong><p><code>{staffPassword}</code></p><button onClick={() => setStaffPassword("")}>Dismiss</button></div>}
        <div className="sd-table-wrap"><table><thead><tr><th>Name / User ID</th><th>Role</th><th>Status</th><th>Access</th></tr></thead><tbody>{data.staff.map(p => <tr key={p.id}><td><strong>{p.full_name}</strong><small>{p.staff_id}</small></td><td>{labels[p.role]}</td><td>{p.active ? "Active" : "Disabled"}{p.must_change_password ? " · Temporary password" : ""}</td><td>{p.id !== profile.id && <div className="sd-actions"><button disabled={busy} onClick={() => void action({ action: "reset_staff", target: p.id })}>Reset password</button><button disabled={busy} onClick={() => void action({ action: "toggle_staff", target: p.id, active: !p.active })}>{p.active ? "Disable" : "Enable"}</button></div>}</td></tr>)}</tbody></table></div>
      </section> : tab === "activity" ? <section className="sd-panel"><h2>Staff activity</h2>{data.audit.length ? data.audit.map(a => <div className="sd-audit-row" key={a.id}><ShieldCheck size={17}/><div><strong>{a.action.replaceAll("_"," ")} · {person(a.actor_id)}</strong><small>{dateTime(a.created_at)}{a.detail.reason ? " · " + String(a.detail.reason) : ""}</small></div>{a.bill_id && <button onClick={() => { setSelectedId(a.bill_id); setPdfUrl(""); }}>Open bill <ChevronRight size={14}/></button>}</div>) : <p>No activity recorded yet.</p>}</section> : <>
        {profile.role === "service_advisor" && tab === "overview" && <section className="sd-upload-panel">
          <div><span className="sd-eyebrow">PDF → VERIFIED BILL</span><h2>No retyping. Just upload.</h2><p>Digital PDFs up to 10 MB. The original stays attached to every bill.</p></div>
          <label className="sd-upload-button"><Upload size={22}/>{busy ? "Reading PDF…" : "Choose bill PDF"}<input type="file" accept=".pdf,application/pdf" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ""; }}/></label>
          {preview.length > 0 && <div className="sd-preview"><h3>{preview.length} bill{preview.length === 1 ? "" : "s"} read from this PDF</h3>{preview.map(b => <div key={b.id}><span className="sd-bill-type">{billType(b)}</span><strong>{b.invoice_reference || "Invoice number not read"} · {billAmount(b)}</strong><p>{b.customer_name || "Customer not read"} · {b.vehicle_no_display || "Vehicle not read"} · {b.invoice_date || "Date not read"}</p><small>{b.amount_evidence}</small>{b.extraction_issues.map(issue => <p className="sd-warning" key={issue}>{issue}</p>)}</div>)}<div className="sd-actions"><button className="sd-secondary" disabled={busy} onClick={() => setPreview([])}>Discard preview</button><button className="sd-primary" disabled={busy} onClick={() => void submit()}>Submit for cashier review <ChevronRight size={16}/></button></div></div>}
        </section>}
        {profile.role !== "service_advisor" && tab === "overview" && <>
          <div className="sd-filters"><label>From<input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}/></label><label>To<input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}/></label><label>Uploaded by<select value={advisor} onChange={e => setAdvisor(e.target.value)}><option value="">All advisors</option>{data.staff.filter(p => p.role === "service_advisor").map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label><button className="sd-plain" onClick={() => { setFrom(""); setTo(""); }}>All dates</button><small>INR · Asia/Kolkata</small></div>
          <div className="sd-metrics">{(["billed","collections","outstanding","pending"] as Metric[]).map(m => <button key={m} className={"sd-metric " + (metric === m ? "is-selected" : "")} onClick={() => { setMetric(m); setQuery(""); setCustomerFilter(null); }}><span>{metricNames[m]}<ArrowUpRight size={18}/></span><strong>{m === "pending" ? summary.totals[m] : money(summary.totals[m])}</strong><small>{m === "billed" ? "By invoice date" : m === "collections" ? "By payment date · net of reversals" : m === "outstanding" ? "Full invoice totals · all dates" : "All dates · excluded from billed value"}</small></button>)}</div>
        </>}
        {customerFilter && <div className="sd-notice">Showing bills for one customer in this view.<button onClick={() => setCustomerFilter(null)}>Show all customers <X size={14}/></button></div>}<section className="sd-panel sd-ledger"><div className="sd-section-heading"><div><span className="sd-eyebrow">{tab === "bills" ? "ALL DATES · PERMANENT RECORDS" : "THE BILLS BEHIND THE NUMBER"}</span><h2>{profile.role === "service_advisor" ? "My bills" : tab === "bills" ? "All bills" : metricNames[metric]}</h2></div><label className="sd-search"><Search size={18}/><input aria-label="Search bills" placeholder="Name, vehicle, VIN, invoice or type" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
          <div className="sd-table-wrap"><table><thead><tr><th>Invoice / Customer</th><th>Vehicle</th><th>{metric === "collections" && tab === "overview" && profile.role !== "service_advisor" ? "Collection recorded" : "Invoice date"}</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
            {metric === "collections" && tab === "overview" && profile.role !== "service_advisor" ? summary.payments.filter(p => { const b = data.bills.find(b => b.id === p.bill_id); return b && matches(b); }).map(p => { const b = data.bills.find(b => b.id === p.bill_id)!; return <tr key={p.id}><td><button className="sd-invoice" onClick={() => { setSelectedId(b.id); setPdfUrl(""); }}>{b.invoice_reference}</button><small>{b.customer_name}</small></td><td>{b.vehicle_no_display || "—"}</td><td>{dateTime(p.occurred_at)}<small>{person(p.recorded_by)}</small></td><td className="sd-money">{money(p.amount_paise)}</td><td><span className="sd-status">{p.source === "reversal" ? "Reversal" : "Paid in full"}</span></td><td><button aria-label="Open invoice" onClick={() => { setSelectedId(b.id); setPdfUrl(""); }}><ChevronRight size={16}/></button></td></tr>; }) :
              customerGroups.map(group => <Fragment key={group.id}><tr className="sd-customer-group"><td colSpan={6}><button onClick={() => setCustomerFilter(group.id)}><Users size={16}/><strong>{group.name}</strong><span>{group.reference ? "Customer ID " + group.reference : "Matched by name + vehicle, or kept separate"}</span><b>{group.bills.length} bill{group.bills.length === 1 ? "" : "s"} · {group.bills.some(b => b.amount_paise !== null) ? money(group.total) : "No amount stated"}{group.missingAmounts > 0 ? " + unread totals" : ""}</b></button></td></tr>{group.bills.map(b => <tr key={b.id}><td><button className="sd-invoice" onClick={() => { setSelectedId(b.id); setPdfUrl(""); }}>{b.invoice_reference || "Needs readable invoice"}</button><small>{b.customer_name || "Billed party not read"}</small><small className="sd-bill-type">{billType(b)}</small><small>{b.uploads?.original_filename}</small></td><td>{b.vehicle_no_display || "Not read"}<small>{b.reference_file ? "Local PDF import" : person(b.uploaded_by)}</small></td><td>{b.invoice_date || "Not read"}</td><td className="sd-money">{billAmount(b)}</td><td><span className={"sd-status " + (isSupportingNote(b) ? "is-note" : billState(b) === "Paid in full" ? "is-paid" : "")}>{billState(b)}</span></td><td><button aria-label="Open invoice" onClick={() => { setSelectedId(b.id); setPdfUrl(""); }}><ChevronRight size={16}/></button></td></tr>)}</Fragment>)}
          </tbody></table></div>
          {!rows.length && <div className="sd-empty"><FileText size={30}/><h3>No bills in this view.</h3><p>{profile.role === "service_advisor" ? "Upload a PDF to send your first bill to the cashier." : "Try all dates, a different total, or a different search."}</p></div>}
          <footer className="sd-ledger-footer"><span>{rows.length} matching bill{rows.length === 1 ? "" : "s"}{tab === "bills" ? " · " + money(rows.reduce((sum,b) => sum+(b.amount_paise ?? 0),0)) + " extracted total" : ""}{query ? " · search filters rows only" : ""}</span><span>Snapshot {data.as_of ? dateTime(data.as_of) : "—"}</span></footer>
        </section>
        {profile.role === "super_admin" && tab === "overview" && <div className="sd-insights">
          <section className="sd-panel"><h2>Collection trend</h2><p className="sd-muted">Net collections by day. Select a day to inspect its payments.</p>{[...groups].sort(([a],[b]) => a.localeCompare(b)).map(([day, amount]) => <button className="sd-trend" key={day} onClick={() => { setFrom(day); setTo(day); setMetric("collections"); }}><span>{day}</span><span className="sd-bar"><i style={{ width: Math.max(3, Math.abs(amount) / Math.max(1,...[...groups.values()].map(Math.abs)) * 100) + "%" }}/></span><strong>{money(amount)}</strong></button>)}{!groups.size && <p>No collections in this period.</p>}</section>
          <section className="sd-panel"><h2>Service value by customer</h2><p className="sd-muted">Approved bills in the selected period, grouped by customer.</p>{groupCustomers(summary.billed).map(g => <button className="sd-customer-value" key={g.id} onClick={() => { setMetric("billed"); setQuery(""); setCustomerFilter(g.id); }}><span>{g.name}<small>{g.bills.length} bill{g.bills.length === 1 ? "" : "s"}</small></span><strong>{money(g.total)} <ChevronRight size={14}/></strong></button>)}{!summary.billed.length && <p>No approved bills in this period.</p>}</section>
        </div>}
      </>}
    </main>
    {selected && <BillDialog bill={selected} onClose={() => { setSelectedId(null); setPdfUrl(""); }}><div className="sd-detail-heading"><span className="sd-eyebrow">ORIGINAL BILL & ACTIVITY</span><h2>{selected.invoice_reference || "Invoice review"}</h2><p>{selected.customer_name} · {selected.vehicle_no_display}</p></div>
      <div className="sd-detail-totals sd-full-total"><div><small>Service bill amount · from PDF</small><strong>{billAmount(selected)}</strong></div><span className={"sd-status " + (isSupportingNote(selected) ? "is-note" : isPaid(selected,data.payments) ? "is-paid" : "")}>{billState(selected)}</span></div>
      <dl className="sd-details"><div><dt>Original file</dt><dd>{selected.uploads?.original_filename || "—"}</dd></div><div><dt>Document type</dt><dd>{billType(selected)}</dd></div><div><dt>Job / repair reference</dt><dd>{selected.job_card_reference || "Not read"}</dd></div><div><dt>Customer ID from PDF</dt><dd>{selected.customer_reference || "Not stated / not read"}</dd></div><div><dt>Customer / vehicle owner</dt><dd>{selected.customer_name || "Not read"}</dd></div><div><dt>Billed to</dt><dd>{selected.field_confidence?.document?.billedTo || selected.customer_name || "Not read"}</dd></div><div><dt>Invoice date</dt><dd>{selected.invoice_date || "Not read"}</dd></div><div><dt>VIN</dt><dd>{selected.vin || "Not read"}</dd></div><div><dt>Uploaded by</dt><dd>{selected.reference_file ? "Local PDF import" : person(selected.uploaded_by)}</dd></div><div><dt>Approved by</dt><dd>{selected.approved_by ? person(selected.approved_by) : isSupportingNote(selected) ? "Supporting note — no collection" : "Awaiting cashier"}</dd></div><div><dt>PDF pages</dt><dd>{selected.page_from}–{selected.page_to}</dd></div><div><dt>Status</dt><dd>{billState(selected)}</dd></div></dl>
      <div className="sd-extraction"><strong>Read directly from PDF</strong><p>{selected.amount_evidence || "No readable total found"}</p>{selected.field_confidence?.document?.typeEvidence && <p>{selected.field_confidence.document.typeEvidence}</p>}<small>{isSupportingNote(selected) ? "Supporting service note. No monetary total is stated; this document is retained with the customer’s bills and excluded from financial totals." : "Financial values cannot be entered or edited manually."}</small></div>
      {selected.extraction_issues.map(issue => <p className="sd-warning" key={issue}>{issue}</p>)}
      <div className="sd-actions"><button className="sd-secondary" disabled={busy} onClick={() => void openPdf(selected)}><FileText size={16}/>View original PDF</button>
        {!demo && profile.role === "service_advisor" && !selected.uploads?.confirmed_at && <button className="sd-primary" disabled={busy} onClick={() => void perform(async () => { await api("/api/uploads/" + selected.upload_id + "/confirm", {}); await refresh(); setNotice("Submitted for cashier review."); })}>Submit draft for review</button>}
        {!demo && profile.role === "super_admin" && selected.approval_status === "pending" && selected.amount_paise === null && !isSupportingNote(selected) && <button disabled={busy} onClick={() => void action({action:"reextract",target:selected.id})}>Re-read original PDF</button>}
        {profile.role === "cashier" && selected.approval_status !== "approved" && !isSupportingNote(selected) && <button className="sd-primary" disabled={busy || selected.amount_paise === null || !selected.invoice_date || !selected.invoice_reference} onClick={() => void action({ action: "approve", target: selected.id })}>Approve bill <Check size={16}/></button>}
        {profile.role === "cashier" && selected.approval_status === "approved" && !isPaid(selected,data.payments) && <button className="sd-primary" disabled={busy} onClick={() => { if (window.confirm("Confirm the full service bill amount of " + money(selected.amount_paise) + " has been collected?")) void action({ action: "collect", target: selected.id }); }}>Mark paid in full · {money(selected.amount_paise)}</button>}
      </div>
      {pdfUrl && <div className="sd-pdf"><a href={pdfUrl + "#page=" + selected.page_from} target="_blank" rel="noreferrer">Open original PDF in a new tab to print ↗</a><iframe title="Original bill PDF" src={pdfUrl + "#page=" + selected.page_from}/></div>}
      <h3>Full-bill collection history</h3>{data.payments.filter(p => p.bill_id === selected.id && !p.is_archived).map(p => <div className="sd-payment" key={p.id}><div><strong>{money(p.amount_paise)}</strong><small>{dateTime(p.occurred_at)} · {person(p.recorded_by)} · {p.source !== "reversal" ? "Full bill collected" : "Full collection reversed"}</small>{p.reason && <p>{p.reason}</p>}</div>{profile.role === "super_admin" && p.source !== "reversal" && !data.payments.some(r => r.reversal_of === p.id) && <button disabled={busy} onClick={() => { const reason = window.prompt("Why is this payment entry incorrect? This is a correction, not a customer refund."); if (reason) void action({ action: "reverse", target: p.id, reason }); }}>Reverse entry</button>}</div>)}
      {!data.payments.some(p => p.bill_id === selected.id && !p.is_archived) && <p className="sd-muted">No collection recorded. An invoice alone does not confirm payment.</p>}
      {selectedGroup && <section className="sd-related"><h3>This customer’s bills</h3><p>{selectedGroup.name}{selectedGroup.reference ? " · Customer ID " + selectedGroup.reference : ""}</p><strong>{selectedGroup.bills.length} bill{selectedGroup.bills.length === 1 ? "" : "s"} · {selectedGroup.bills.some(b => b.amount_paise !== null) ? money(selectedGroup.total) + " stated invoice value" : "No monetary total stated"}{selectedGroup.missingAmounts > 0 ? " (some totals unread)" : ""}</strong><small>All accessible bills, including those awaiting approval.</small>{selectedGroup.bills.map(b => <button key={b.id} aria-current={b.id === selected.id ? "true" : undefined} onClick={() => { setSelectedId(b.id); setPdfUrl(""); }}><span>{b.invoice_reference || "Invoice not read"}<small>{billType(b)}</small><small>{b.invoice_date || "Date not read"} · {b.vehicle_no_display || "Vehicle not read"}</small></span><strong>{billAmount(b)}</strong><ChevronRight size={15}/></button>)}</section>}
      <h3>Bill timeline</h3>{data.audit.filter(a => a.bill_id === selected.id).map(a => <div className="sd-audit-row" key={a.id}><Check size={16}/><div><strong>{a.action.replaceAll("_"," ")} · {person(a.actor_id)}</strong><small>{dateTime(a.created_at)}{a.detail.reason ? " · " + String(a.detail.reason) : ""}</small></div></div>)}
      {notice && <p className="sd-alert" role="status">{notice}</p>}
    </BillDialog>}
  </div>;
}

function Brand() { return <div className="sd-brand"><span><FileText size={22}/></span>Bill<span>Desk</span></div>; }
function BillDialog({ bill, onClose, children }: { bill: DeskBill; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="sd-dialog" aria-label={"Bill " + (bill.invoice_reference ?? "")} onCancel={onClose}><button autoFocus className="sd-dialog-close" aria-label="Close bill details" onClick={onClose}><X size={20}/></button>{children}</dialog>;
}
