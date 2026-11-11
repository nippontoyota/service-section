"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { ArrowUpRight, Check, ChevronRight, Eye, EyeOff, FileText, LayoutDashboard, LogOut, Search, ShieldCheck, Trash2, Upload, Users, X } from "lucide-react";
import { cashierDailyReport, cashierView, compareCashierTokens, paymentReferenceLabel, billAmount, billType, isSupportingNote, customerKey, groupCustomers, isPaid, indiaDate, money, report, paymentMethods, tokenNumber, type DeskBill, type Metric, type Snapshot, type Staff } from "@/lib/desk";
import { DEMO_KEY, demoAccounts, demoAction, demoDeleteStaff, demoPdf, freshDemo, upgradeDemo } from "@/lib/desk-demo";
import type { ExtractedBill } from "@/lib/pdf/extract";
import { importReferenceBills, isBuiltInSample } from "@/lib/import-reference-bills";
import { DeskShell } from "./desk-shell";
import { fileIdentity, selectFiles, restoreDrafts, withTwoWorkers, type UploadFile } from "@/lib/upload-queue";
import { PdfLinks } from "@/lib/pdf-preview";
import { billContacts, customerPhone, whatsappMessage } from "@/lib/whatsapp";
import "./service-desk.css";

const labels = { cashier: "Cashier", service_advisor: "Service advisor", super_admin: "Super admin" };
const metricNames = { paid: "Total paid bills", unpaid: "Total unpaid bills", pending: "Awaiting approval" };
const dateTime = (date: string) => new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const empty: Snapshot = { bills: [], payments: [], staff: [], audit: [], as_of: "" };
type ActionBody = { action: string; target?: string; reason?: string; [key: string]: unknown };

const readDemo = (): Snapshot => {
  const stored = JSON.parse(localStorage.getItem(DEMO_KEY) || "null") ?? freshDemo();
  const upgraded = upgradeDemo(stored);
  if (upgraded !== stored) localStorage.setItem(DEMO_KEY,JSON.stringify(upgraded));
  return upgraded;
};

export function ServiceDesk({ demo, ready, initial, initialError = "", requireToken = false }: { demo: boolean; ready: boolean; initial?: { profile: Staff; snapshot?: Snapshot }; initialError?: string; requireToken?: boolean }) {
  const [profile, setProfile] = useState<Staff | null>(initial?.profile ?? null);
  const [data, setData] = useState<Snapshot>(initial?.snapshot ?? empty);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(initialError);
  const [restoring, setRestoring] = useState(demo || Boolean(initialError));
  const [refreshError, setRefreshError] = useState(initialError);
  const [tab, setTab] = useState(initial?.profile.role === "cashier" ? "overview" : demo ? "bills" : "overview");
  const [metric, setMetric] = useState<Metric>("paid");
  const [query, setQuery] = useState("");
  const [customerFilter, setCustomerFilter] = useState<string | null>(null);
  const [advisor, setAdvisor] = useState("");
  const [analyticsDay, setAnalyticsDay] = useState(() => indiaDate());
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [skips, setSkips] = useState<Record<string, boolean>>({});
  const [sharingBills, setSharingBills] = useState<DeskBill[]>([]);
  const [prepared, setPrepared] = useState<Record<string, { url: string; expiresAt: string; phone: string }>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [files, setFiles] = useState<UploadFile[]>(() => initial?.profile.role === "service_advisor" && initial.snapshot ? restoreDrafts(initial.snapshot) : []);
  const preview = files.flatMap(f => f.bills);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const batchLock = useRef(false);
  const refreshVersion = useRef(0);
  const links = useRef(new PdfLinks());
  const localUrls = useRef(new Map<string, string>());
  const pdfRequest = useRef(0);
  const pdfDisplayStart = useRef("");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const profileId = useRef(initial?.profile.id);
  const initialFetch = useRef(demo || Boolean(initialError));
  const clearPreviews = useCallback(() => {
    pdfRequest.current++;
    links.current.clear();
    for (const url of localUrls.current.values()) URL.revokeObjectURL(url);
    localUrls.current.clear();
    setPdfUrl(""); setPdfError(""); setPdfLoading(false);
  }, []);
  const acceptSnapshot = useCallback((snapshot: Snapshot, user: Staff | null) => {
    setData(snapshot); setProfile(user); setRestoring(false); setRefreshError("");
    if (user?.id !== profileId.current) {
      clearPreviews(); setFiles([]); setSelectedId(null); setUploadOpen(false);
      setPhones({}); setSkips({}); setPrepared({}); setSharingBills([]); setTokens({});
      setTab(user?.role === "cashier" ? "overview" : demo ? "bills" : "overview");
      profileId.current = user?.id;
    }
    if (user?.role === "service_advisor" && !batchLock.current) setFiles(current => {
      const recovered = restoreDrafts({ ...snapshot, bills: snapshot.bills.filter(b => b.uploaded_by === user.id) });
      return [...current, ...recovered.filter(d => !current.some(f => f.uploadId === d.uploadId))];
    });
  }, [clearPreviews, demo]);
  const [showPassword, setShowPassword] = useState(false);
  const [staffPassword, setStaffPassword] = useState("");
  const staffForm = useRef<HTMLFormElement>(null);

  const api = useCallback(async (url: string, body?: unknown) => {
    const response = await fetch(url, { method: body ? "POST" : "GET", credentials: "same-origin", headers: {
      "Content-Type": "application/json",
    }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    return result;
  }, []);
  const refresh = useCallback(async () => {
    const version = refreshVersion.current;
    if (demo) {
      const response = await fetch("/api/demo/reference-bills");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (version !== refreshVersion.current) return;
      const current = readDemo();
      if (current.bills.some(isBuiltInSample) && !localStorage.getItem("service-desk-before-reference-import")) {
        localStorage.setItem("service-desk-before-reference-import",JSON.stringify(current));
      }
      const snapshot = importReferenceBills(current,result.bills);
      localStorage.setItem(DEMO_KEY,JSON.stringify(snapshot));
      const id = sessionStorage.getItem("desk-demo-user");
      const user = snapshot.staff.find(p => p.id === id && p.active) ?? null;
      acceptSnapshot(snapshot, user);
    } else if (ready) {
      const response = await fetch("/api/desk", { credentials: "same-origin", cache: "no-store" });
      if (version !== refreshVersion.current) return;
      if (response.status === 401) { acceptSnapshot(empty, null); clearPreviews(); setFiles([]); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load workspace");
      if (version === refreshVersion.current) acceptSnapshot(result.snapshot ?? empty, result.profile);
    }
  }, [demo, ready, acceptSnapshot, clearPreviews]);
  useEffect(() => {
    const listener = () => void refresh().catch(e => { setNotice(e.message); setRefreshError(e.message); });
    const timer = window.setInterval(listener, 30000);
    window.addEventListener("storage", listener);
    if (initialFetch.current) { initialFetch.current = false; listener(); }
    return () => { window.removeEventListener("storage", listener); window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => () => clearPreviews(), [clearPreviews]);
  useEffect(() => {
    if (!files.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [files.length]);
  const selectedBill = preview.find(b => b.id === selectedId) ?? data.bills.find(b => b.id === selectedId);
  useEffect(() => {
    if (!selectedBill || demo || localUrls.current.has(selectedBill.upload_id)) return;
    void links.current.get(selectedBill.upload_id, () => api("/api/desk", { action: "pdf", target: selectedBill.id })).catch(() => {});
  }, [selectedBill, api, demo]);

  function save(snapshot: Snapshot) { localStorage.setItem(DEMO_KEY, JSON.stringify(snapshot)); setData(snapshot); }
  async function perform(task: () => Promise<void>) {
    if (busy) return;
    refreshVersion.current++;
    setBusy(true); setNotice("");
    try { await task(); } catch (e) { const message = e instanceof Error ? e.message : "Something went wrong"; setNotice(message); if (task === refresh) setRefreshError(message); }
    finally { refreshVersion.current++; setBusy(false); }
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
        acceptSnapshot(snapshot, account);
      } else {
        await api("/api/auth/login", { staffId, password });
        await refresh();
      }
      setMetric("paid"); setCustomerFilter(null);
    });
  }
  async function logout() {
    if (batchLock.current) { setNotice("Wait for the current batch to finish before signing out."); return; }
    if (files.length && !window.confirm("Leave unfinished work? Uploaded drafts can be recovered; local files must be selected again.")) return;
    refreshVersion.current++;
    if (!demo) {
      try { await api("/api/auth/logout", {}); }
      catch (e) { setNotice(e instanceof Error ? e.message : "Could not sign out"); return; }
    }
    refreshVersion.current++;
    sessionStorage.removeItem("desk-demo-user"); setProfile(null); setData(empty); setSelectedId(null); clearPreviews(); profileId.current = undefined; setFiles([]); setTokens({}); setUploadOpen(false); setShowPassword(false); setNotice(""); setStaffPassword("");
    setPhones({}); setSkips({}); setPrepared({}); setSharingBills([]);
  }
  async function action(body: ActionBody) {
    if (!profile) return;
    await perform(async () => {
      if (demo) {
        const snapshot = readDemo();
        const current = snapshot.staff.find(p => p.id === profile.id);
        if (!current?.active) throw new Error("Account disabled");
        if (["approve","collect","reverse"].includes(body.action)) save(demoAction(snapshot, current, body.action, body.target!, body.reason, body.method as string | undefined, body.otherMethod as string | undefined, body.transactionId));
        else if (body.action === "delete_staff") {
          const next = demoDeleteStaff(snapshot, current, body.target!);
          const target = snapshot.staff.find(p => p.id === body.target)!;
          const passwords = JSON.parse(localStorage.getItem("desk-demo-passwords") || "{}");
          delete passwords[target.staff_id];
          localStorage.setItem("desk-demo-passwords", JSON.stringify(passwords));
          setStaffPassword(""); save(next);
        } else if (body.action === "password") {
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
            if (typeof body.password !== "string" || body.password.length < 6 || body.password.length > 8) throw new Error("Use a password between 6 and 8 characters");
            if (snapshot.staff.some(p => p.staff_id === body.staffId)) throw new Error("User ID already exists");
            target = { id: crypto.randomUUID(), staff_id: String(body.staffId), full_name: String(body.fullName), role: body.role as Staff["role"], active: true, must_change_password: false };
            snapshot.staff.push(target);
          }
          if (!target || target.id === current.id) throw new Error("Select another staff account");
          if (body.action === "toggle_staff") target.active = Boolean(body.active);
          else {
            const password = body.action === "create_staff" ? body.password : "Demo!" + crypto.randomUUID().slice(0,16);
            passwords[target.staff_id] = password; target.must_change_password = body.action === "reset_staff";
            localStorage.setItem("desk-demo-passwords", JSON.stringify(passwords));
            if (body.action === "reset_staff") setStaffPassword(target.staff_id + " · " + password);
          }
          snapshot.audit.unshift({ id: crypto.randomUUID(), bill_id: null, actor_id: current.id, action: body.action, created_at: new Date().toISOString(), detail: { target: target.id } });
          save(snapshot);
        }
      } else {
        const result = await api("/api/desk", body);
        if (result.temporaryPassword) setStaffPassword("Temporary password: " + result.temporaryPassword);
        await refresh();
      }
      if (body.action === "collect") {
        pdfRequest.current++; setSelectedId(null); setPdfUrl(""); setPdfLoading(false); setPdfError("");
      }
      if (body.action === "create_staff") { staffForm.current?.reset(); setStaffPassword(""); }
      if (body.action === "delete_staff") setStaffPassword("");
      setNotice(body.action === "collect" ? "Bill marked as paid and moved to Archive." : body.action === "delete_staff" ? "Account permanently deleted." : "Saved successfully.");
    });
  }
  function updateFile(id: string, patch: Partial<UploadFile>) {
    setFiles(current => current.map(f => f.id === id ? { ...f, ...patch } : f));
  }
  function addFiles(incoming: File[]) {
    const { added, errors } = selectFiles(files, incoming);
    const entries = added.map(file => {
      const id = crypto.randomUUID(), localUrl = URL.createObjectURL(file);
      localUrls.current.set(id, localUrl);
      return { id, identity: fileIdentity(file), name: file.name, file, localUrl, progress: 0, bills: [], state: "selected" as const };
    });
    setFiles(current => [...current, ...entries]);
    setNotice(errors.join(" "));
  }
  async function upload(item: UploadFile): Promise<DeskBill[]> {
    if (!profile) throw new Error("Staff login required");
    const file = item.file;
    updateFile(item.id, { state: "uploading", error: undefined });
    if (demo) {
      if (!file) throw new Error("Reselect the original PDF.");
      const form = new FormData(); form.set("file", file);
      updateFile(item.id, { state: "reading", progress: 70 });
      const response = await fetch("/api/demo/extract", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const snapshot = readDemo();
      if (snapshot.bills.some(b => b.uploads?.file_hash === result.hash && b.uploads?.confirmed_at)) throw new Error("This PDF has already been submitted");
      const uploadId = item.uploadId || crypto.randomUUID();
      await demoPdf(uploadId, file);
      updateFile(item.id, { uploadId, stored: true });
      if (item.localUrl) localUrls.current.set(uploadId, item.localUrl);
      const bills: DeskBill[] = result.bills.map((b: ExtractedBill) => ({
        id: crypto.randomUUID(), upload_id: uploadId, customer_name: b.customerName, vehicle_no_display: b.vehicleNo, vin: b.vin,
        customer_reference: b.customerReference || null, job_card_reference: b.jobCardReference || null,
        field_confidence: { ...b.confidence, document: b.document },
        invoice_reference: b.invoiceReference || null, invoice_date: b.invoiceDate, amount_paise: b.amountPaise,
        amount_evidence: b.amountEvidence, payment_evidence: b.paymentEvidence, extraction_issues: b.extractionIssues,
        page_from: b.pageFrom, page_to: b.pageTo, uploaded_by: profile.id, created_at: new Date().toISOString(),
        approved_at: null, approved_by: null, approval_status: "pending", status: "needs_review",
        uploads: { original_filename: file.name, confirmed_at: null, file_hash: result.hash },
      }));
      snapshot.bills.push(...bills); save(snapshot);
      return bills;
    }
    let uploadId = item.uploadId;
    if (!item.stored) {
      if (!file) throw new Error("Reselect the original PDF to finish uploading.");
      const init = await api("/api/uploads/init", { uploadId, filename: file.name, size: file.size, type: "application/pdf" });
      uploadId = init.uploadId;
      updateFile(item.id, { uploadId, signedUrl: init.signedUrl });
      try { await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", init.signedUrl); xhr.setRequestHeader("Content-Type", "application/pdf");
        xhr.upload.onprogress = event => { if (event.lengthComputable) updateFile(item.id, { progress: Math.round(event.loaded / event.total * 70) }); };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("PDF upload failed. Retry this file."));
        xhr.onerror = () => reject(new Error("PDF upload failed. Check your connection and retry."));
        xhr.timeout = 120_000; xhr.ontimeout = () => reject(new Error("PDF upload timed out. Retry this file."));
        xhr.send(file);
      }); } catch (transferError) {
        // Check storage through processing before asking the user to transfer again.
        try {
          const result = await api("/api/uploads/" + uploadId + "/process", {});
          updateFile(item.id, { stored: true });
          if (item.localUrl && uploadId) localUrls.current.set(uploadId, item.localUrl);
          return result.bills;
        } catch { throw transferError; }
      }
      updateFile(item.id, { stored: true });
    }
    if (item.localUrl && uploadId) localUrls.current.set(uploadId, item.localUrl);
    updateFile(item.id, { state: "reading", progress: 80 });
    const result = await api("/api/uploads/" + uploadId + "/process", {});
    return result.bills;
  }
  async function uploadFiles(only?: UploadFile) {
    if (batchLock.current) return;
    batchLock.current = true; refreshVersion.current++; setBatchBusy(true); setNotice("");
    const pending = only ? [only] : files.filter(f => !f.bills.length && (f.state === "selected" || f.state === "failed"));
    let failed = 0;
    try {
      await withTwoWorkers(pending, async item => {
        try { updateFile(item.id, { bills: await upload(item), state: "ready", progress: 100, error: undefined }); }
        catch (e) { failed++; updateFile(item.id, { state: "failed", error: e instanceof Error ? e.message : "Upload failed. Retry this file." }); }
      });
      setNotice(`${pending.length - failed} PDF(s) ready for review. ${failed} failed.`);
    } finally { refreshVersion.current++; batchLock.current = false; setBatchBusy(false); }
  }
  const phoneFor = (bill: DeskBill) => phones[bill.id] ?? bill.customer_phone ?? "+91 ";
  function reserveWhatsAppTab() {
    try {
      const popup = window.open("about:blank", "_blank");
      if (popup) { popup.opener = null; popup.document.title = "Preparing WhatsApp"; popup.document.body.textContent = "Preparing your bill message…"; }
      return popup;
    } catch { return null; }
  }
  async function prepareWhatsApp(bill: DeskBill, phone: string, popup: Window | null) {
    const result = await api(`/api/bills/${bill.id}/whatsapp`, { customerPhone: phone });
    setPrepared(current => ({ ...current, [bill.id]: { url: result.whatsappUrl, expiresAt: result.expiresAt, phone } }));
    setPhones(current => ({ ...current, [bill.id]: phone }));
    // The visible link remains usable if the browser refuses automatic navigation.
    try { if (popup && !popup.closed) popup.location.replace(result.whatsappUrl); } catch { popup?.close(); }
  }
  function openWhatsApp(bill: DeskBill) {
    if (demo || busy || batchLock.current) return;
    let phone: string;
    try { phone = customerPhone(phoneFor(bill)); } catch (e) { setNotice((e as Error).message); return; }
    const popup = reserveWhatsAppTab();
    void perform(async () => {
      try {
        await prepareWhatsApp(bill, phone, popup);
        setNotice("WhatsApp message prepared. Press Send in your own WhatsApp. Delivery is not tracked.");
        await refresh().catch(e => setRefreshError(e.message));
      } catch (e) { popup?.close(); throw e; }
    });
  }
  async function submit(only?: UploadFile, skipAll = false) {
    if (batchLock.current || busy || !profile) return;
    batchLock.current = true; refreshVersion.current++; setBatchBusy(true); setNotice("");
    const pending = only ? [only] : files.filter(f => f.bills.length && f.state === "ready");
    const allBills = pending.flatMap(f => f.bills);
    const single = allBills.length === 1 && !skipAll && !skips[allBills[0].id] ? allBills[0] : null;
    let popup: Window | null = null;
    if (single && !demo) {
      try { customerPhone(phoneFor(single)); if (!requireToken || tokenNumber(tokens[single.id] ?? single.token_number)) popup = reserveWhatsAppTab(); }
      catch { /* The review card below will show validation errors. */ }
    }
    let failed = 0;
    let sharingError = "";
    try {
      await withTwoWorkers(pending, async item => {
        updateFile(item.id, { state: "submitting", error: undefined });
        try {
          const billTokens = Object.fromEntries(item.bills.map(b => [b.id, tokenNumber(tokens[b.id] ?? b.token_number)]));
          if (requireToken && Object.values(billTokens).some(token => !token)) throw new Error("Token number is required for every bill at this branch");
          const contacts = billContacts(Object.fromEntries(item.bills.map(b => [b.id, { phone: phoneFor(b), skipWhatsApp: skipAll || Boolean(skips[b.id]) }])));
          const now = new Date().toISOString();
          const submitted = item.bills.map(b => ({ ...b, token_number: billTokens[b.id], customer_phone: contacts[b.id].phone, uploads: { ...b.uploads!, confirmed_at: now } }));
          if (demo) {
            const snapshot = readDemo();
            if (snapshot.bills.some(b => b.upload_id !== item.uploadId && b.uploads?.confirmed_at && b.uploads.file_hash === item.bills[0].uploads?.file_hash)) throw new Error("This PDF has already been submitted");
            submitted.forEach(b => {
              const index = snapshot.bills.findIndex(existing => existing.id === b.id);
              snapshot.bills[index] = { ...b, customer_id: "demo-customer:" + customerKey(b) };
              snapshot.audit.unshift({ id: crypto.randomUUID(), bill_id: b.id, actor_id: profile.id, action: "submitted", created_at: now, detail: { token_number: billTokens[b.id] } });
              if (contacts[b.id].skipWhatsApp) snapshot.audit.unshift({ id: crypto.randomUUID(), bill_id: b.id, actor_id: profile.id, action: "whatsapp_skipped", created_at: now, detail: {} });
            });
            save(snapshot);
          } else await api("/api/uploads/" + item.uploadId + "/confirm", { tokens: billTokens, contacts });
          setFiles(current => current.filter(f => f.id !== item.id));
          setSelectedId(current => item.bills.some(b => b.id === current) ? null : current);
          const toShare = submitted.filter(b => !contacts[b.id].skipWhatsApp);
          setSharingBills(current => [...current.filter(b => !submitted.some(s => s.id === b.id)), ...toShare]);
          if (single && !demo && toShare.length) {
            try { await prepareWhatsApp(toShare[0], contacts[toShare[0].id].phone!, popup); }
            catch (e) { popup?.close(); sharingError = " Submitted to cashier; WhatsApp preparation failed. " + (e as Error).message + " Use Open WhatsApp to retry."; }
          }
        } catch (e) { popup?.close(); failed++; updateFile(item.id, { state: "ready", error: e instanceof Error ? e.message : "Submission failed. Retry this PDF." }); }
      });
      // Refresh only after successful items have been removed; a failed refresh must not undo submission.
      if (!demo) await refresh().catch(e => setRefreshError(e.message));
      setNotice(`${pending.length - failed} PDF(s) submitted to cashier. ${failed} failed${failed ? "; retry the remaining PDFs." : "."}` + sharingError + (demo ? " Demo customer sharing is disabled." : !sharingError && single && !failed ? " Press Send in WhatsApp; use Open WhatsApp below if it did not open." : ""));
    } finally { refreshVersion.current++; batchLock.current = false; setBatchBusy(false); }
  }
  function forgetPreview(uploadId: string) {
    links.current.delete(uploadId);
    const url = localUrls.current.get(uploadId);
    if (url) {
      URL.revokeObjectURL(url);
      for (const [key, value] of localUrls.current) if (value === url) localUrls.current.delete(key);
    }
    pdfRequest.current++; setPdfUrl(""); setPdfLoading(false); setPdfError("");
  }
  async function removeFile(item: UploadFile) {
    if (batchLock.current || busy) return;
    if (item.uploadId && !window.confirm("Delete this uploaded draft PDF and its draft bills?")) return;
    await perform(async () => {
      if (item.uploadId) {
        if (demo) { const snapshot = readDemo(); snapshot.bills = snapshot.bills.filter(b => b.upload_id !== item.uploadId); save(snapshot); }
        else { const result = await api("/api/uploads/" + item.uploadId + "/delete", {}); if (result.warning) setNotice(result.warning); }
      }
      forgetPreview(item.uploadId || item.id);
      setFiles(current => current.filter(f => f.id !== item.id));
      if (!demo && item.uploadId) await refresh();
    });
  }
  async function deleteBill(bill: DeskBill) {
    if (!window.confirm(`Delete draft ${bill.invoice_reference || bill.uploads?.original_filename || "bill"}? This cannot be undone. Other bills in the PDF will remain.`)) return;
    await perform(async () => {
      let warning: string | undefined;
      if (demo) {
        if (profile?.role !== "service_advisor" || bill.uploaded_by !== profile.id || bill.uploads?.confirmed_at || bill.approval_status !== "pending") throw new Error("Only your own draft bills can be deleted");
        const snapshot = readDemo();
        snapshot.bills = snapshot.bills.filter(b => b.id !== bill.id); save(snapshot);
      } else { const result = await api("/api/bills/" + bill.id + "/delete", {}); warning = result.warning; }
      forgetPreview(bill.upload_id);
      setFiles(current => current.map(f => f.uploadId === bill.upload_id ? { ...f, localUrl: undefined, bills: f.bills.filter(b => b.id !== bill.id) } : f).filter(f => f.uploadId !== bill.upload_id || f.bills.length));
      setSelectedId(null); setPdfUrl("");
      if (!demo) await refresh();
      setNotice(warning || "Draft bill deleted.");
    });
  }
  function selectBill(id: string | null) {
    pdfRequest.current++; setSelectedId(id); setPdfUrl(""); setPdfLoading(false); setPdfError("");
  }
  async function openPdf(bill: DeskBill) {
    const request = ++pdfRequest.current;
    setPdfLoading(true); setPdfError(""); setPdfUrl("");
    try {
      let url = localUrls.current.get(bill.upload_id);
      if (!url) {
        let blob: Blob;
        if (demo && !bill.reference_file) {
          const stored = await demoPdf(bill.upload_id);
          if (!stored) throw new Error("This PDF is not stored in this browser. Please upload the original again.");
          blob = stored;
        } else {
          const link = demo ? { url: "/api/demo/reference-bills?file=" + encodeURIComponent(bill.reference_file || "") } : await links.current.get(bill.upload_id, () => api("/api/desk", { action: "pdf", target: bill.id }));
          if (request !== pdfRequest.current) return;
          const started = "pdf-download-start:" + request;
          performance.mark(started);
          const response = await fetch(link.url);
          if (!response.ok) { links.current.delete(bill.upload_id); throw new Error("PDF could not be downloaded. Please retry."); }
          blob = await response.blob();
          performance.measure("pdf-download", started); performance.clearMarks(started);
          if ("timings" in link && link.timings) {
            performance.measure("pdf-authorization", { start: 0, duration: link.timings.authorization });
            performance.measure("pdf-signing", { start: 0, duration: link.timings.signing });
          }
        }
        if (request !== pdfRequest.current) return;
        url = URL.createObjectURL(blob); localUrls.current.set(bill.upload_id, url);
      }
      if (request !== pdfRequest.current) return;
      pdfDisplayStart.current = "pdf-display-start:" + request;
      performance.mark(pdfDisplayStart.current);
      setPdfUrl(url);
    } catch (e) { if (request === pdfRequest.current) { setPdfError(e instanceof Error ? e.message : "PDF could not be loaded"); setPdfLoading(false); } }
  }

  function whatsappFields(bill: DeskBill, draft: boolean) {
    const skipped = draft && Boolean(skips[bill.id]);
    const link = prepared[bill.id];
    return <div className="sd-whatsapp">
      <label>Customer WhatsApp number<input type="tel" autoComplete="off" value={phoneFor(bill)} maxLength={40} disabled={busy || batchBusy || skipped}
        onChange={e => { setPhones(current => ({ ...current, [bill.id]: e.target.value })); setPrepared(current => { const next = { ...current }; delete next[bill.id]; return next; }); }} placeholder="+91 98765 43210"/></label>
      <small>India defaults to +91. For another country, enter + and its country code. Verify the customer and number before sending.</small>
      {draft && <label className="sd-check"><input type="checkbox" checked={skipped} disabled={busy || batchBusy} onChange={e => setSkips(current => ({ ...current, [bill.id]: e.target.checked }))}/>Submit this bill without WhatsApp</label>}
      {!skipped && <details><summary>Preview preset message</summary><p className="sd-message-preview">{whatsappMessage({ ...bill, token_number: tokens[bill.id] ?? bill.token_number }, "[Private bill link · valid for 7 days]", profile?.full_name ?? "")}</p></details>}
      {demo && <small>Customer sharing is disabled in this local demo. PDFs stored in this browser cannot be opened by customers.</small>}
      {!draft && <div className="sd-actions"><button disabled={demo || busy || batchBusy} onClick={() => openWhatsApp(bill)}>{link ? "Prepare fresh WhatsApp message" : "Open WhatsApp"}</button>
        {link && link.phone === phoneFor(bill) && <a href={link.url} target="_blank" rel="noreferrer" onClick={e => { if (Date.parse(link.expiresAt) <= Date.now()) { e.preventDefault(); setNotice("This bill link expired. Prepare a fresh WhatsApp message."); } }}>Open WhatsApp</a>}
      </div>}
      {link && <small>Message prepared · link expires {dateTime(link.expiresAt)}. Press Send in your own WhatsApp. Delivery is not tracked.</small>}
    </div>;
  }
  function sharingQueue() {
    if (!sharingBills.length) return null;
    return <section className="sd-sharing-queue" aria-label="Submitted bills to share"><h3>Submitted to cashier · share with customers</h3><p>Open each chat separately. You can also share again from My bills.</p>
      {sharingBills.map(bill => <article key={bill.id} className="sd-review-card"><strong>{bill.invoice_reference || "Bill"} · {bill.customer_name || "Customer"}</strong>{whatsappFields(bill, false)}<button className="sd-plain" disabled={busy || batchBusy} onClick={() => setSharingBills(current => current.filter(b => b.id !== bill.id))}>Dismiss</button></article>)}
    </section>;
  }
  function submitLabel(items: UploadFile[]) {
    const bills = items.flatMap(item => item.bills);
    return bills.length === 1 ? skips[bills[0].id] ? "Submit without WhatsApp" : demo ? "Submit to cashier" : "Submit & open WhatsApp" : "Submit all";
  }

  if (restoring && !profile) return <DeskShell>{refreshError ? <div role="alert"><p>{refreshError}</p><button onClick={() => void perform(refresh)}>Retry workspace</button></div> : undefined}</DeskShell>;

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
        <label>Password<span className="sd-password-field"><input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required /><button className="sd-password-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={19}/> : <Eye size={19}/>}</button></span></label>
        <button className="sd-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<ArrowUpRight size={18}/></button>
      </form>}
      {notice && <p role="alert" className="sd-alert">{notice}</p>}
      {demo && <div className="sd-demo-accounts"><strong>Try a workspace</strong>{demoAccounts.map(p => <div key={p.id}><span>{labels[p.role]}<b>{p.staff_id}</b></span><code>{p.password}</code></div>)}<small>Local test accounts. The three supplied PDFs load automatically; workflow changes stay in this browser.</small></div>}
      <small className="sd-muted">Need access? Contact your centre administrator.</small>
    </div></section>
  </div>;

  if (profile.must_change_password) return <div className="sd-loading"><div className="sd-password"><Brand/><h1>Set your own password.</h1><p>Your temporary password must be changed before you can access bills.</p><form onSubmit={e => { e.preventDefault(); void action({ action: "password", password: new FormData(e.currentTarget).get("password") }); }}><label>New password<input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password"/></label><button className="sd-primary" disabled={busy}>Save password</button></form><p role="status">{notice}</p><button className="sd-plain" onClick={() => void logout()}>Sign out</button></div></div>;

  const visible: Snapshot = profile.role === "service_advisor" ? { ...data, bills: data.bills.filter(b => b.uploaded_by === profile.id) } : data;
  const summary = report(visible, advisor);
  const daily = profile.role === "cashier" ? cashierDailyReport(visible, analyticsDay) : null;
  const selected = preview.find(b => b.id === selectedId) ?? data.bills.find(b => b.id === selectedId);
  const person = (id: string | null) => data.staff.find(p => p.id === id)?.full_name ?? (id ? "Staff member" : "Deleted staff account");
  const billState = (b: DeskBill) => !b.uploads?.confirmed_at ? "Draft" : isSupportingNote(b) ? "No collection required" : isPaid(b, data.payments) ? "Paid in full" : profile.role === "cashier" ? "In progress" : b.approval_status !== "approved" ? "Awaiting approval" : "Unpaid";
  const list = profile.role === "cashier" ? visible.bills.filter(b => cashierView(b, data.payments) === tab) : tab === "bills" || profile.role === "service_advisor" ? visible.bills : summary[metric];
  const matches = (b: DeskBill) => (!customerFilter || (b.customer_id || customerKey(b)) === customerFilter) && [b.token_number,b.customer_name,b.customer_reference,b.vehicle_no_display,b.vin,b.invoice_reference,b.job_card_reference,billType(b),b.field_confidence?.document?.billedTo].some(v => v?.toLowerCase().includes(query.toLowerCase()));
  const rows = [...new Map(list.filter(matches).map(b => [b.id,b])).values()];
  if (profile.role === "cashier") rows.sort(compareCashierTokens);
  const customerGroups = groupCustomers(rows);
  const selectedGroup = selected ? groupCustomers(visible.bills).find(g => g.id === (selected.customer_id || customerKey(selected))) : undefined;

  return <div className="sd-app">
    <aside className="sd-sidebar"><Brand/><span className="sd-eyebrow">{labels[profile.role]} WORKSPACE</span><nav>
      <button aria-current={tab === "overview" ? "page" : undefined} onClick={() => { setTab("overview"); setQuery(""); setCustomerFilter(null); }}><LayoutDashboard size={19}/>{profile.role === "service_advisor" ? "Upload & my bills" : "Overview"}</button>
      <button aria-current={tab === (profile.role === "cashier" ? "archive" : "bills") ? "page" : undefined} onClick={() => { setTab(profile.role === "cashier" ? "archive" : "bills"); setQuery(""); setCustomerFilter(null); }}><FileText size={19}/>{profile.role === "cashier" ? "Archive" : "Bill archive"}<span>{profile.role === "cashier" ? visible.bills.filter(b => cashierView(b, data.payments) === "archive").length : visible.bills.length}</span></button>
      {profile.role === "super_admin" && <><button aria-current={tab === "staff" ? "page" : undefined} onClick={() => setTab("staff")}><Users size={19}/>Staff accounts</button><button aria-current={tab === "activity" ? "page" : undefined} onClick={() => setTab("activity")}><ShieldCheck size={19}/>Activity log</button></>}
    </nav><div className="sd-sidebar-bottom"><span className="sd-retained"><ShieldCheck size={18}/>Permanent bill history</span><strong>{profile.full_name}</strong><small>{profile.staff_id} · {labels[profile.role]}</small><button className="sd-plain" onClick={() => void logout()}><LogOut size={16}/>Sign out</button></div></aside>
    <main className="sd-main">
      {demo && <div className="sd-demo-banner">LOCAL PDF WORKSPACE <span>Supplied PDFs and local uploads · no Supabase connection</span></div>}
      <header className="sd-header"><div><span className="sd-eyebrow">BILLDESK / {labels[profile.role].toUpperCase()}</span><h1>{tab === "staff" ? "Your people. Their access." : tab === "activity" ? "A record of every action." : tab === "archive" ? "Archive" : tab === "bills" ? "The bill archive." : profile.role === "service_advisor" ? "Send bills to the counter." : "Overview"}</h1><p>{profile.role === "service_advisor" ? "Choose a PDF. Amounts and details are read automatically." : profile.role === "cashier" ? tab === "archive" ? "Paid bills and supporting documents." : "Review pending bills and mark them as paid to move them to Archive." : "Track paid bills, unpaid bills, and bills awaiting approval."}</p></div><button className="sd-secondary" disabled={busy} onClick={() => void perform(refresh)}>Refresh</button></header>
      {refreshError && <div className="sd-notice" role="alert">{refreshError}<button disabled={busy} onClick={() => void perform(refresh)}>Retry refresh</button></div>}
      {notice && <div className="sd-notice" role="status">{notice}<button aria-label="Dismiss message" onClick={() => setNotice("")}><X size={16}/></button></div>}
      {tab === "staff" && profile.role === "super_admin" ? <section className="sd-panel">
        <h2>Create a staff account</h2><form ref={staffForm} className="sd-staff-form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void action({ action: "create_staff", staffId: f.get("staffId"), fullName: f.get("fullName"), role: f.get("role"), password: f.get("password") }); }}>
          <label>Full name<input name="fullName" maxLength={100} required/></label><label>User ID<input name="staffId" autoComplete="off" pattern="[a-z0-9_]{3,40}" title="3–40 lowercase letters, numbers or underscores" required/></label><label>Password<input name="password" type="password" minLength={6} maxLength={8} placeholder="6–8 characters" autoComplete="new-password" required/></label><label>Role<select name="role"><option value="service_advisor">Service advisor</option><option value="cashier">Cashier</option><option value="super_admin">Super admin</option></select></label><button className="sd-primary" disabled={busy}>Create account</button>
        </form>{staffPassword && <div className="sd-alert"><strong>Share privately; shown for this session only.</strong><p><code>{staffPassword}</code></p><button onClick={() => setStaffPassword("")}>Dismiss</button></div>}
        <div className="sd-table-wrap"><table><thead><tr><th>Name / User ID</th><th>Role</th><th>Status</th><th>Access</th></tr></thead><tbody>{data.staff.map(p => <tr key={p.id}><td><strong>{p.full_name}</strong><small>{p.staff_id}</small></td><td>{labels[p.role]}</td><td>{p.active ? "Active" : "Disabled"}{p.must_change_password ? " · Temporary password" : ""}</td><td>{p.id !== profile.id && <div className="sd-actions"><button disabled={busy} onClick={() => void action({ action: "reset_staff", target: p.id })}>Reset password</button><button disabled={busy} onClick={() => void action({ action: "toggle_staff", target: p.id, active: !p.active })}>{p.active ? "Disable" : "Enable"}</button>{p.staff_id !== "admin01" && <button className="sd-danger" disabled={busy} onClick={() => { if (window.confirm(`Permanently delete ${p.full_name} (${p.staff_id})? Their account and access will be removed. Bill and collection history will be retained.`)) void action({ action: "delete_staff", target: p.id }); }}><Trash2 size={16}/>Delete account</button>}</div>}</td></tr>)}</tbody></table></div>
      </section> : tab === "activity" ? <section className="sd-panel"><h2>Staff activity</h2>{data.audit.length ? data.audit.map(a => <div className="sd-audit-row" key={a.id}><ShieldCheck size={17}/><div><strong>{a.action.replaceAll("_"," ")} · {person(a.actor_id)}</strong><small>{dateTime(a.created_at)}{a.detail.reason ? " · " + String(a.detail.reason) : ""}</small></div>{a.bill_id && <button onClick={() => { selectBill(a.bill_id); }}>Open bill <ChevronRight size={14}/></button>}</div>) : <p>No activity recorded yet.</p>}</section> : <>
        {profile.role === "service_advisor" && <><div className="sd-upload-launch"><button className="sd-primary" onClick={() => setUploadOpen(true)}><Upload size={18}/>Upload bills{files.length ? ` (${files.length})` : ""}</button></div>{!uploadOpen && sharingQueue()}</>}
        {daily && tab === "overview" && <section aria-label="Daily analytics">
          <div className="sd-filters"><label>Analytics date<input type="date" value={analyticsDay} onChange={e => setAnalyticsDay(e.target.value || indiaDate())}/></label><button className="sd-plain" onClick={() => setAnalyticsDay(indiaDate())}>Today</button><small>By invoice date · current payment status · INR</small></div>
          <div className="sd-metrics sd-daily-metrics" aria-live="polite">
            <div className="sd-metric"><span>Total amount billed</span><strong>{money(daily.billedAmount)}</strong><small>{daily.bills} bill{daily.bills === 1 ? "" : "s"}</small></div>
            <div className="sd-metric"><span>Total paid bills</span><strong>{daily.paid}</strong><small>{money(daily.paidAmount)} paid</small></div>
            <div className="sd-metric"><span>Total unpaid bills</span><strong>{daily.unpaid}</strong><small>{money(daily.unpaidAmount)} unpaid</small></div>
          </div>
          {daily.unreadAmounts > 0 && <p className="sd-warning">{daily.unreadAmounts} bill{daily.unreadAmounts === 1 ? " has" : "s have"} unread amounts and {daily.unreadAmounts === 1 ? "is" : "are"} counted above but excluded from monetary totals.</p>}
        </section>}
        {profile.role === "super_admin" && tab === "overview" && <>
          <div className="sd-filters"><label>Uploaded by<select value={advisor} onChange={e => { setAdvisor(e.target.value); setQuery(""); setCustomerFilter(null); }}><option value="">All advisors</option>{data.staff.filter(p => p.role === "service_advisor").map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label><small>All dates · current bill status · INR</small></div>
          <div className="sd-metrics" aria-live="polite">{(["paid","unpaid","pending"] as Metric[]).map(m => <button key={m} aria-pressed={metric === m} className={"sd-metric " + (metric === m ? "is-selected" : "")} onClick={() => { setMetric(m); setQuery(""); setCustomerFilter(null); }}><span>{metricNames[m]}<ArrowUpRight size={18}/></span><strong>{summary[m].length}</strong><small>{m === "paid" ? money(summary.paidAmount) + " paid" : m === "unpaid" ? money(summary.unpaidAmount) + " unpaid · includes awaiting approval" : "Waiting for cashier approval"}</small></button>)}</div>
          {summary.unreadAmounts > 0 && <p className="sd-warning">{summary.unreadAmounts} bill{summary.unreadAmounts === 1 ? " has" : "s have"} unread amounts and {summary.unreadAmounts === 1 ? "is" : "are"} counted above but excluded from monetary totals.</p>}
        </>}
        {customerFilter && <div className="sd-notice">Showing bills for one customer in this view.<button onClick={() => setCustomerFilter(null)}>Show all customers <X size={14}/></button></div>}<section className="sd-panel sd-ledger"><div className="sd-section-heading"><div><span className="sd-eyebrow">{tab === "bills" ? "ALL DATES · PERMANENT RECORDS" : "ALL DATES"}</span><h2>{profile.role === "service_advisor" ? "My bills" : tab === "archive" ? "Archive" : tab === "bills" ? "All bills" : profile.role === "cashier" ? "Pending bills" : metricNames[metric]}</h2></div><label className="sd-search"><Search size={18}/><input aria-label="Search bills" placeholder="Token, name, vehicle, VIN or invoice" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
          <div className="sd-table-wrap"><table><thead><tr><th>Invoice / Customer</th><th>Token no.</th><th>Vehicle</th><th>Invoice date</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
            {profile.role === "cashier" ? rows.map(b => <BillRow key={b.id} bill={b} state={billState(b)} uploader={person(b.uploaded_by)} onSelect={selectBill}/>) : customerGroups.map(group => <Fragment key={group.id}><tr className="sd-customer-group"><td colSpan={7}><button onClick={() => setCustomerFilter(group.id)}><Users size={16}/><strong>{group.name}</strong><span>{group.reference ? "Customer ID " + group.reference : "Matched by name + vehicle, or kept separate"}</span><b>{group.bills.length} bill{group.bills.length === 1 ? "" : "s"} · {group.bills.some(b => b.amount_paise !== null) ? money(group.total) : "No amount stated"}{group.missingAmounts > 0 ? " + unread totals" : ""}</b></button></td></tr>{group.bills.map(b => <BillRow key={b.id} bill={b} state={billState(b)} uploader={person(b.uploaded_by)} onSelect={selectBill}/>)}</Fragment>)}
          </tbody></table></div>
          {!rows.length && <div className="sd-empty"><FileText size={30}/><h3>No bills in this view.</h3><p>{profile.role === "service_advisor" ? "Upload a PDF to send your first bill to the cashier." : profile.role === "cashier" ? query ? "Try a different search." : tab === "overview" ? "All submitted bills have been handled." : "Paid bills will appear here." : "Try another bill status, advisor, or search."}</p></div>}
          <footer className="sd-ledger-footer"><span>{rows.length} matching bill{rows.length === 1 ? "" : "s"}{tab === "bills" ? " · " + money(rows.reduce((sum,b) => sum+(b.amount_paise ?? 0),0)) + " extracted total" : ""}{query ? " · search filters rows only" : ""}</span><span>Snapshot {data.as_of ? dateTime(data.as_of) : "—"}</span></footer>
        </section>
      </>}
    </main>
    {uploadOpen && <UploadDialog onClose={() => setUploadOpen(false)}>
      <header className="sd-upload-heading"><div><h2>Upload bills</h2><p>Review each bill, then submit to the cashier. Up to 10 PDFs · 10 MB each.</p></div>
        <label className="sd-upload-button"><Upload size={20}/>Add PDFs<input aria-label="Add PDFs" type="file" accept=".pdf,application/pdf" multiple disabled={batchBusy || busy} onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}/></label>
      </header>
      <p className="sd-upload-summary" role="status">{files.filter(f => f.state === "ready").length} ready · {files.filter(f => f.error).length} failed · {files.length} / 10 PDFs</p>
      <div className="sd-upload-queue">{files.map(f => <section className={"sd-queue-item" + (f.error ? " has-error" : "")} key={f.id}>
        <div className="sd-upload-file"><FileText size={19} aria-hidden="true"/><span><strong>{f.name}</strong><small>{({ selected: "Ready to upload", uploading: "Uploading…", reading: "Reading bill details…", ready: "Ready for review", failed: "Failed", submitting: "Submitting…" })[f.state]}</small></span><button disabled={batchBusy || busy} aria-label={"Remove " + f.name} onClick={() => void removeFile(f)}><X size={16}/></button></div>
        {(f.state === "uploading" || f.state === "reading") && <progress aria-label={"Progress for " + f.name} max={100} value={f.progress}/>}
        {f.error && <p className="sd-warning" role="alert">{f.error}</p>}
        <div className="sd-actions">
          {f.localUrl && !f.bills.length && <a href={f.localUrl + "#page=1"} target="_blank" rel="noreferrer">View PDF</a>}
          {f.state === "failed" && !f.file && <label className="sd-upload-button">Reselect PDF<input aria-label={"Reselect " + f.name} type="file" accept=".pdf,application/pdf" disabled={batchBusy || busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; const result = selectFiles([], [file]); if (result.errors.length) { setNotice(result.errors.join(" ")); return; } if (file.name !== f.name) { setNotice("Select the original file with the same name."); return; } const localUrl = URL.createObjectURL(file); localUrls.current.set(f.id, localUrl); updateFile(f.id, { file, localUrl, stored: false, identity: fileIdentity(file), state: "selected", error: undefined }); }}/></label>}
          {f.error && (f.file || f.stored || f.bills.length > 0) && <button disabled={batchBusy || busy} onClick={() => void (f.bills.length ? submit(f) : uploadFiles(f))}>Retry {f.bills.length ? "submission" : "processing"}</button>}
        </div>
        {f.bills.map(b => <article className="sd-review-card" key={b.id}>
          <div className="sd-review-meta"><span className="sd-bill-type">{billType(b)}</span><small>Pages {b.page_from}–{b.page_to}</small></div>
          <div className="sd-review-heading"><div><small>Invoice</small><h3 className="sd-review-reference">{b.invoice_reference || "Invoice number not read"}</h3></div><div className="sd-review-amount"><small>Bill amount</small><strong>{billAmount(b)}</strong></div></div>
          <div className="sd-review-customer"><small>Customer</small><strong>{b.customer_name || "Customer not read"}</strong></div>
          <dl className="sd-review-fields"><div><dt>Vehicle</dt><dd>{b.vehicle_no_display || "Vehicle not read"}</dd></div><div><dt>Invoice date</dt><dd>{b.invoice_date || "Date not read"}</dd></div></dl>
          <label>Token number ({requireToken ? "required" : "optional"})<input required={requireToken} value={tokens[b.id] ?? b.token_number ?? ""} onChange={e => setTokens(current => ({ ...current, [b.id]: e.target.value }))} maxLength={30} placeholder="Enter token from your token machine" disabled={batchBusy || busy}/></label>
          {whatsappFields(b, true)}
          <small className="sd-review-evidence">{b.amount_evidence}</small>
          {b.extraction_issues.map(issue => <p className="sd-warning" key={issue}>{issue}</p>)}
          <div className="sd-actions"><button onClick={() => { setSelectedId(b.id); void openPdf(b); }}><Eye size={16}/>View bill</button><button className="sd-danger" disabled={batchBusy || busy} onClick={() => void deleteBill(b)}><Trash2 size={16}/>Delete draft</button></div>
        </article>)}
      </section>)}</div>
      {!files.length && <p>No PDFs selected. Uploaded drafts are restored here after a reload.</p>}
      {sharingQueue()}
      <div className="sd-actions sd-upload-footer"><button className="sd-secondary" disabled={batchBusy || busy || !files.some(f => !f.bills.length && (f.state === "selected" || f.state === "failed") && (f.file || f.stored))} onClick={() => void uploadFiles()}>Upload &amp; read all</button><button className="sd-primary" disabled={batchBusy || busy || !files.some(f => f.state === "ready")} onClick={() => void submit()}>{submitLabel(files.filter(f => f.state === "ready"))}</button><button disabled={batchBusy || busy || !files.some(f => f.state === "ready")} onClick={() => void submit(undefined, true)}>Submit all without WhatsApp</button></div>
      {notice && <p role="status" className="sd-notice">{notice}</p>}
    </UploadDialog>}
    {selected && <BillDialog bill={selected} onClose={() => { pdfRequest.current++; setSelectedId(null); setPdfUrl(""); setPdfLoading(false); setPdfError(""); }}><div className="sd-detail-heading"><span className="sd-eyebrow">ORIGINAL BILL & ACTIVITY</span><h2>{selected.invoice_reference || "Invoice review"}</h2><p>{selected.customer_name} · {selected.vehicle_no_display}</p></div>
      {pdfLoading && <p role="status">Loading PDF…</p>}{pdfError && <div role="alert" className="sd-warning">{pdfError}<button onClick={() => void openPdf(selected)}>Retry PDF</button></div>}
      {pdfUrl && <div className="sd-pdf"><a href={pdfUrl + "#page=" + selected.page_from} target="_blank" rel="noreferrer">Open original PDF in a new tab to print ↗</a><iframe onLoad={() => { performance.measure("pdf-display", pdfDisplayStart.current); setPdfLoading(false); }} title="Original bill PDF" src={pdfUrl + "#page=" + selected.page_from}/></div>}
      <div className="sd-detail-totals sd-full-total"><div><small>Service bill amount · from PDF</small><strong>{billAmount(selected)}</strong></div><span className={"sd-status " + (isSupportingNote(selected) ? "is-note" : isPaid(selected,data.payments) ? "is-paid" : "")}>{billState(selected)}</span></div>
      <dl className="sd-details"><div><dt>Token number</dt><dd>{selected.token_number || "Not assigned"}</dd></div><div><dt>Original file</dt><dd>{selected.uploads?.original_filename || "—"}</dd></div><div><dt>Document type</dt><dd>{billType(selected)}</dd></div><div><dt>Job / repair reference</dt><dd>{selected.job_card_reference || "Not read"}</dd></div><div><dt>Customer ID from PDF</dt><dd>{selected.customer_reference || "Not stated / not read"}</dd></div><div><dt>Customer / vehicle owner</dt><dd>{selected.customer_name || "Not read"}</dd></div><div><dt>Billed to</dt><dd>{selected.field_confidence?.document?.billedTo || selected.customer_name || "Not read"}</dd></div><div><dt>Invoice date</dt><dd>{selected.invoice_date || "Not read"}</dd></div><div><dt>VIN</dt><dd>{selected.vin || "Not read"}</dd></div><div><dt>Uploaded by</dt><dd>{selected.reference_file ? "Local PDF import" : person(selected.uploaded_by)}</dd></div><div><dt>Approved by</dt><dd>{selected.approval_status === "approved" ? person(selected.approved_by) : isSupportingNote(selected) ? "Supporting note — no collection" : "Awaiting cashier"}</dd></div><div><dt>PDF pages</dt><dd>{selected.page_from}–{selected.page_to}</dd></div><div><dt>Status</dt><dd>{billState(selected)}</dd></div></dl>
      <div className="sd-extraction"><strong>Read directly from PDF</strong><p>{selected.amount_evidence || "No readable total found"}</p>{selected.field_confidence?.document?.typeEvidence && <p>{selected.field_confidence.document.typeEvidence}</p>}<small>{isSupportingNote(selected) ? "Supporting service note. No monetary total is stated; this document is retained with the customer’s bills and excluded from financial totals." : "Financial values cannot be entered or edited manually."}</small></div>
      {selected.extraction_issues.map(issue => <p className="sd-warning" key={issue}>{issue}</p>)}
      {profile.role === "service_advisor" && !selected.uploads?.confirmed_at && <label>Token number ({requireToken ? "required" : "optional"})<input required={requireToken} value={tokens[selected.id] ?? selected.token_number ?? ""} onChange={e => setTokens(current => ({ ...current, [selected.id]: e.target.value }))} maxLength={30} placeholder="Enter token from your token machine" disabled={batchBusy || busy}/></label>}
      {profile.role === "service_advisor" && selected.uploaded_by === profile.id && whatsappFields(selected, !selected.uploads?.confirmed_at)}
      <div className="sd-actions"><button className="sd-secondary" disabled={pdfLoading} onClick={() => void openPdf(selected)}><FileText size={16}/>View original PDF</button>
        {profile.role === "service_advisor" && !selected.uploads?.confirmed_at && <button className="sd-primary" disabled={busy || batchBusy} onClick={() => { const item = files.find(f => f.uploadId === selected.upload_id); if (item) void submit(item); }}>{submitLabel(files.filter(f => f.uploadId === selected.upload_id))}</button>}
        {profile.role === "service_advisor" && selected.uploaded_by === profile.id && !selected.uploads?.confirmed_at && selected.approval_status === "pending" && <button className="sd-danger" disabled={busy || batchBusy} onClick={() => void deleteBill(selected)}><Trash2 size={16}/>Delete bill</button>}
        {!demo && profile.role === "super_admin" && selected.approval_status === "pending" && selected.amount_paise === null && !isSupportingNote(selected) && <button disabled={busy} onClick={() => void action({action:"reextract",target:selected.id})}>Re-read original PDF</button>}
      </div>
      {profile.role === "cashier" && selected.uploads?.confirmed_at && !isSupportingNote(selected) && !isPaid(selected,data.payments) && <PaymentForm key={selected.id} bill={selected} busy={busy} onConfirm={(method, otherMethod, transactionId) => void action({ action: "collect", target: selected.id, method, otherMethod, transactionId })}/>}
      <h3>Full-bill collection history</h3>{data.payments.filter(p => p.bill_id === selected.id && !p.is_archived).map(p => <div className="sd-payment" key={p.id}><div><strong>{money(p.amount_paise)}</strong><small>{dateTime(p.occurred_at)} · {person(p.recorded_by)} · {p.method} · {p.source !== "reversal" ? "Full bill collected" : "Full collection reversed"}</small>{p.transaction_id && <small>{paymentReferenceLabel(p.method) || "Transaction ID"}: {p.transaction_id}</small>}{p.reason && <p>{p.reason}</p>}</div>{profile.role === "super_admin" && p.source !== "reversal" && !data.payments.some(r => r.reversal_of === p.id) && <button disabled={busy} onClick={() => { const reason = window.prompt("Why is this payment entry incorrect? This is a correction, not a customer refund."); if (reason) void action({ action: "reverse", target: p.id, reason }); }}>Reverse entry</button>}</div>)}
      {!data.payments.some(p => p.bill_id === selected.id && !p.is_archived) && <p className="sd-muted">No collection recorded. An invoice alone does not confirm payment.</p>}
      {selectedGroup && <section className="sd-related"><h3>This customer’s bills</h3><p>{selectedGroup.name}{selectedGroup.reference ? " · Customer ID " + selectedGroup.reference : ""}</p><strong>{selectedGroup.bills.length} bill{selectedGroup.bills.length === 1 ? "" : "s"} · {selectedGroup.bills.some(b => b.amount_paise !== null) ? money(selectedGroup.total) + " stated invoice value" : "No monetary total stated"}{selectedGroup.missingAmounts > 0 ? " (some totals unread)" : ""}</strong><small>All accessible bills, including those awaiting approval.</small>{selectedGroup.bills.map(b => <button key={b.id} aria-current={b.id === selected.id ? "true" : undefined} onClick={() => { selectBill(b.id); }}><span>{b.invoice_reference || "Invoice not read"}<small>{billType(b)}</small><small>{b.invoice_date || "Date not read"} · {b.vehicle_no_display || "Vehicle not read"}</small></span><strong>{billAmount(b)}</strong><ChevronRight size={15}/></button>)}</section>}
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

function UploadDialog({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="sd-dialog sd-upload-dialog" aria-label="Upload and review bills" onCancel={onClose}><button autoFocus className="sd-dialog-close" aria-label="Close upload dialog" onClick={onClose}><X size={20}/></button>{children}</dialog>;
}

function BillRow({ bill: b, state, uploader, onSelect }: { bill: DeskBill; state: string; uploader: string; onSelect: (id: string) => void }) {
  return <tr key={b.id}><td><button className="sd-invoice" onClick={() => { onSelect(b.id); }}>{b.invoice_reference || "Needs readable invoice"}</button><small>{b.customer_name || "Billed party not read"}</small><small className="sd-bill-type">{billType(b)}</small><small>{b.uploads?.original_filename}</small></td><td><strong>{b.token_number || "—"}</strong></td><td>{b.vehicle_no_display || "Not read"}<small>{b.reference_file ? "Local PDF import" : uploader}</small></td><td>{b.invoice_date || "Not read"}</td><td className="sd-money">{billAmount(b)}</td><td><span className={"sd-status " + (isSupportingNote(b) ? "is-note" : state === "Paid in full" ? "is-paid" : "")}>{state}</span></td><td><button aria-label="Open invoice" onClick={() => { onSelect(b.id); }}><ChevronRight size={16}/></button></td></tr>;
}

function PaymentForm({ bill, busy, onConfirm }: { bill: DeskBill; busy: boolean; onConfirm: (method: string, otherMethod: string, transactionId: string) => void }) {
  const [method, setMethod] = useState("");
  const [otherMethod, setOtherMethod] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const referenceLabel = paymentReferenceLabel(method);
  return <form className="sd-payment-form" onSubmit={e => { e.preventDefault(); onConfirm(method, otherMethod, referenceLabel ? transactionId : ""); }}>
    <label>Mode of payment<select required value={method} disabled={busy} onChange={e => { setMethod(e.target.value); setOtherMethod(""); setTransactionId(""); }}>
      <option value="" disabled>Select payment method</option>{paymentMethods.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
    {method === "Other" && <label>Specify other payment method<input required maxLength={100} value={otherMethod} disabled={busy} onChange={e => setOtherMethod(e.target.value)} placeholder="Enter payment method"/></label>}
    {referenceLabel && <label>{referenceLabel} (required)<input required maxLength={100} value={transactionId} disabled={busy} onChange={e => setTransactionId(e.target.value)} placeholder={"Enter " + referenceLabel.toLowerCase()}/></label>}
    <button className="sd-primary" disabled={busy || !method || Boolean(referenceLabel && !transactionId.trim()) || (method === "Other" && !otherMethod.trim()) || bill.amount_paise === null || !bill.invoice_date || !bill.invoice_reference?.trim()}>Mark as paid · {money(bill.amount_paise)} <Check size={16}/></button>
  </form>;
}
