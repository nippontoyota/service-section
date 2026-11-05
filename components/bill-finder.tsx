"use client";

import {
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileSearch,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Printer,
  RotateCcw,
  Search,
  Settings,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dashboardCounts, filterBills, groupBills, localDateKey, normalizeIdentifier } from "@/lib/bill-utils";
import { demoBills } from "@/lib/demo-data";
import type { Bill, BillFilter } from "@/lib/types";

const STORAGE_KEY = "service-desk-demo-bills";

const timeFormatter = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function initials(name: string) {
  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function statusLabel(status: Bill["status"]) {
  if (status === "needs_review") return "Needs review";
  if (status === "paid") return "Paid";
  return "Ready";
}

function StatTile({
  title,
  value,
  detail,
  filter,
  active,
  icon,
  onClick,
}: {
  title: string;
  value: number;
  detail: string;
  filter: BillFilter;
  active: boolean;
  icon: React.ReactNode;
  onClick: (filter: BillFilter) => void;
}) {
  return (
    <button
      type="button"
      className={`stat-tile ${active ? "is-active" : ""}`}
      onClick={() => onClick(filter)}
      aria-pressed={active}
    >
      <span className="stat-icon">{icon}</span>
      <span className="stat-copy">
        <span className="stat-label">{title}</span>
        <strong>{String(value).padStart(2, "0")}</strong>
        <span className="stat-detail">{detail}</span>
      </span>
      <span className="stat-arrow"><ChevronRight size={17} /></span>
    </button>
  );
}

export function BillFinder() {
  const supabase = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    return url && key ? createClient(url, key) : null;
  }, []);
  const [bills, setBills] = useState<Bill[]>(demoBills);
  const [selectedDate, setSelectedDate] = useState(() => localDateKey(new Date()));
  const [filter, setFilter] = useState<BillFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [selectedPdfUrl, setSelectedPdfUrl] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ fullName: string; role: "service_advisor" | "cashier" } | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(supabase));
  const [mounted, setMounted] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshLiveBills = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("bills")
      .select("*, uploads!inner(original_filename, confirmed_at), profiles!bills_uploaded_by_fkey(full_name)")
      .not("uploads.confirmed_at", "is", null)
      .order("created_at", { ascending: false });
    if (error) throw error;

    type LiveRow = {
      id: string; upload_id: string; connection_key: string; connection_key_type: Bill["connectionKeyType"];
      customer_name: string; vehicle_no_display: string; vin: string; invoice_reference?: string;
      created_at: string; status: Bill["status"]; paid_at?: string; page_from: number; page_to: number;
      uploads: { original_filename: string }; profiles: { full_name: string };
    };
    setBills((data as unknown as LiveRow[]).map((row) => ({
      id: row.id,
      uploadId: row.upload_id,
      connectionKey: row.connection_key,
      connectionKeyType: row.connection_key_type,
      customerName: row.customer_name,
      vehicleNo: row.vehicle_no_display,
      vin: row.vin,
      invoiceReference: row.invoice_reference ?? undefined,
      advisorName: row.profiles.full_name,
      createdAt: row.created_at,
      status: row.status,
      paidAt: row.paid_at ?? undefined,
      pageFrom: row.page_from,
      pageTo: row.page_to,
      fileName: row.uploads.original_filename,
    })));
  }, [supabase]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (supabase) return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const savedBills = JSON.parse(stored) as Bill[];
        window.setTimeout(() => setBills(savedBills), 0);
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
    searchRef.current?.focus();
  }, [supabase]);

  useEffect(() => {
    if (!supabase) return;
    let active = true;

    const connect = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      const token = data.session?.access_token ?? null;
      setSessionToken(token);
      if (!data.session) {
        setAuthLoading(false);
        return;
      }
      const { data: profileRow } = await supabase
        .from("profiles")
        .select("full_name, role")
        .eq("id", data.session.user.id)
        .single();
      if (!active) return;
      if (profileRow) setProfile({ fullName: profileRow.full_name, role: profileRow.role });
      if (profileRow?.role === "cashier") await refreshLiveBills();
      setAuthLoading(false);
    };

    void connect();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setSessionToken(null);
        setProfile(null);
      } else {
        void connect();
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [refreshLiveBills, supabase]);

  useEffect(() => {
    if (!supabase || profile?.role !== "cashier") return;
    const channel = supabase
      .channel("cashier-bills")
      .on("postgres_changes", { event: "*", schema: "public", table: "bills" }, () => void refreshLiveBills())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [profile?.role, refreshLiveBills, supabase]);

  useEffect(() => {
    if (!supabase || !selectedBill) {
      const frame = window.requestAnimationFrame(() => setSelectedPdfUrl(null));
      return () => window.cancelAnimationFrame(frame);
    }
    let active = true;
    const loadPdf = async () => {
      const { data: upload } = await supabase.from("uploads").select("storage_path").eq("id", selectedBill.uploadId).single();
      if (!upload || !active) return;
      const { data } = await supabase.storage.from("bills").createSignedUrl(upload.storage_path, 300);
      if (active) setSelectedPdfUrl(data?.signedUrl ?? null);
    };
    void loadPdf();
    return () => { active = false; };
  }, [selectedBill, supabase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const saveBills = (next: Bill[]) => {
    setBills(next);
    if (!supabase) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const counts = useMemo(() => dashboardCounts(bills, selectedDate), [bills, selectedDate]);
  const visibleBills = useMemo(
    () => filterBills(bills, selectedDate, filter, query),
    [bills, selectedDate, filter, query],
  );
  const groups = useMemo(() => groupBills(visibleBills), [visibleBills]);

  const chooseFilter = (nextFilter: BillFilter) => {
    setFilter(nextFilter);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  };

  const markPaid = async (ids: string[]) => {
    if (supabase) {
      const { error } = await supabase.rpc("mark_bills_paid", { target_ids: ids });
      if (error) return setToast(error.message);
      await refreshLiveBills();
      setSelectedBill(null);
      return setToast(`${ids.length === 1 ? "Bill" : `${ids.length} bills`} marked as paid`);
    }
    const now = new Date().toISOString();
    saveBills(
      bills.map((bill) =>
        ids.includes(bill.id) && bill.status !== "paid"
          ? { ...bill, status: "paid", paidAt: now }
          : bill,
      ),
    );
    setSelectedBill(null);
    setToast(`${ids.length === 1 ? "Bill" : `${ids.length} bills`} marked as paid`);
  };

  const undoPaid = async (ids: string[]) => {
    if (supabase) {
      const { error } = await supabase.rpc("undo_payment", { target_ids: ids, target_batch: null });
      if (error) return setToast(error.message);
      await refreshLiveBills();
      setSelectedBill(null);
      return setToast("Payment status restored");
    }
    saveBills(
      bills.map((bill) =>
        ids.includes(bill.id)
          ? {
              ...bill,
              status: bill.vin && bill.vehicleNo && bill.customerName ? "ready" : "needs_review",
              paidAt: undefined,
            }
          : bill,
      ),
    );
    setSelectedBill(null);
    setToast("Payment status restored");
  };

  const printBill = (bill: Bill) => {
    setSelectedBill(bill);
    window.setTimeout(() => window.print(), 100);
  };

  const openBill = (bill: Bill) => {
    setSelectedPdfUrl(null);
    setSelectedBill(bill);
  };

  const selectedDateLabel = dateFormatter.format(new Date(`${selectedDate}T12:00:00`));
  const displayName = profile?.fullName ?? "Riya Nair";

  if (!mounted || authLoading) return <LoadingScreen />;
  if (supabase && !sessionToken) return <LoginScreen supabase={supabase} />;
  if (supabase && sessionToken && !profile) {
    return <AccessError onSignOut={() => void supabase.auth.signOut()} />;
  }
  if (supabase && sessionToken && profile?.role === "service_advisor") {
    return <AdvisorPortal supabase={supabase} token={sessionToken} profileName={displayName} />;
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "is-open" : ""}`}>
        <div className="brand" aria-label="Service Desk">
          <span className="brand-mark"><FileSearch size={19} strokeWidth={2.4} /></span>
          <span>Service<span>Desk</span></span>
        </div>

        <nav aria-label="Primary navigation">
          <a className="nav-item is-current" href="#dashboard" aria-current="page">
            <LayoutDashboard size={19} /><span>Dashboard</span>
          </a>
          <button className="nav-item" type="button" onClick={() => chooseFilter("needs_review")}>
            <FileText size={19} /><span>Needs review</span>
            {counts.needs_review > 0 && <b>{counts.needs_review}</b>}
          </button>
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item" type="button"><Settings size={19} /><span>Settings</span></button>
          <button className="nav-item" type="button"><CircleHelp size={19} /><span>Help</span></button>
          <button className="nav-item" type="button" onClick={() => void supabase?.auth.signOut()}><LogOut size={19} /><span>Sign out</span></button>
        </div>
      </aside>

      {mobileNavOpen && <button className="nav-scrim" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />}

      <section className="workspace" id="dashboard">
        <header className="topbar">
          <button className="mobile-menu" type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div className="mobile-brand">ServiceDesk</div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="Notifications"><Bell size={19} /></button>
            <div className="user-block">
              <div className="avatar">{initials(displayName)}</div>
              <div><strong>{displayName}</strong><span>Cashier</span></div>
            </div>
          </div>
        </header>

        <div className="dashboard-wrap">
          <section className="dashboard-main">
            <div className="welcome-row">
              <div>
                <p className="eyebrow">Cash counter · Live queue</p>
                <h1>Good morning, {displayName.split(" ")[0]}.</h1>
                <p className="welcome-copy">Find the right bill, print it, and settle the visit.</p>
              </div>
            </div>

            <div className="control-row">
              <label className="search-box">
                <Search size={21} />
                <span className="sr-only">Search bills</span>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search VIN, last 6, vehicle number or customer"
                />
                {query && (
                  <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={17} /></button>
                )}
                <kbd>⌘ K</kbd>
              </label>
              <label className="date-control">
                <CalendarDays size={18} />
                <span className="sr-only">Bill date</span>
                <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
              </label>
            </div>

            <section className="stats" aria-label={`Bill totals for ${selectedDateLabel}`}>
              <StatTile
                title="Total bills"
                value={counts.all}
                detail={selectedDateLabel}
                filter="all"
                active={filter === "all"}
                icon={<FileText size={19} />}
                onClick={chooseFilter}
              />
              <StatTile
                title="Marked as paid"
                value={counts.paid}
                detail={counts.all ? `${Math.round((counts.paid / counts.all) * 100)}% settled` : "No bills yet"}
                filter="paid"
                active={filter === "paid"}
                icon={<CheckCircle2 size={19} />}
                onClick={chooseFilter}
              />
              <StatTile
                title="Unpaid bills"
                value={counts.unpaid}
                detail={counts.needs_review ? `${counts.needs_review} need review` : "Ready at the counter"}
                filter="unpaid"
                active={filter === "unpaid"}
                icon={<Clock3 size={19} />}
                onClick={chooseFilter}
              />
            </section>

            <section className="queue-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{selectedDateLabel}</p>
                  <h2>{filter === "all" ? "All bills" : filter === "paid" ? "Paid bills" : filter === "needs_review" ? "Needs review" : "Unpaid bills"}</h2>
                </div>
                <span>{visibleBills.length} {visibleBills.length === 1 ? "bill" : "bills"}</span>
              </div>

              <div className="bill-list">
                {groups.map((group) => {
                  const lead = group.bills[0];
                  const unpaidIds = group.bills.filter((bill) => bill.status !== "paid").map((bill) => bill.id);
                  return (
                    <article className="bill-group" key={group.key}>
                      <div className="group-customer">
                        <div className="customer-avatar">{initials(lead.customerName || "Unknown")}</div>
                        <div>
                          <div className="name-line">
                            <h3>{lead.customerName || "Customer name missing"}</h3>
                            {group.bills.length > 1 && <span className="group-count">{group.bills.length} linked bills</span>}
                          </div>
                          <p>{lead.vehicleNo || "Vehicle number missing"} <i /> <span>{lead.vin ? `VIN ···${lead.vin.slice(-6)}` : "VIN missing"}</span></p>
                        </div>
                        {unpaidIds.length > 1 && (
                          <button className="group-pay" type="button" onClick={() => markPaid(unpaidIds)}>
                            <Check size={16} /> Pay group
                          </button>
                        )}
                      </div>

                      <div className="group-bills">
                        {group.bills.map((bill) => (
                          <button className="bill-row" type="button" key={bill.id} onClick={() => openBill(bill)}>
                            <span className="file-icon"><FileText size={19} /></span>
                            <span className="bill-primary">
                              <strong>{bill.invoiceReference || "Reference pending"}</strong>
                              <span>{bill.fileName}</span>
                            </span>
                            <span className="advisor-cell"><span className="mini-avatar">{initials(bill.advisorName)}</span>{bill.advisorName}</span>
                            <span className="time-cell">{timeFormatter.format(new Date(bill.createdAt))}</span>
                            <span className={`status-pill ${bill.status}`}>{statusLabel(bill.status)}</span>
                            <ChevronRight className="row-arrow" size={18} />
                          </button>
                        ))}
                      </div>
                    </article>
                  );
                })}

                {groups.length === 0 && (
                  <div className="empty-state">
                    <span><FileSearch size={27} /></span>
                    <h3>No bills found</h3>
                    <p>Try another date, clear your search, or choose a different bill filter.</p>
                    <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>Show all bills</button>
                  </div>
                )}
              </div>
            </section>
          </section>

          <aside className="insight-panel">
            <section className="settlement-card">
              <div className="settlement-top">
                <span>Today’s settlement</span>
                <MoreHorizontal size={18} />
              </div>
              <strong>{counts.all ? Math.round((counts.paid / counts.all) * 100) : 0}%</strong>
              <div className="settlement-bar"><i style={{ width: `${counts.all ? (counts.paid / counts.all) * 100 : 0}%` }} /></div>
              <div className="settlement-legend"><span>{counts.paid} paid</span><span>{counts.unpaid} remaining</span></div>
            </section>

            <button className={`review-card ${filter === "needs_review" ? "is-active" : ""}`} type="button" onClick={() => chooseFilter("needs_review")}>
              <span className="review-icon"><Pencil size={19} /></span>
              <span><b>{counts.needs_review}</b><strong>Needs review</strong><small>Missing details to complete</small></span>
              <ChevronRight size={18} />
            </button>

            <section className="activity-card">
              <div className="aside-heading"><h2>Recent activity</h2><span>Live</span></div>
              <div className="activity-list">
                {bills
                  .filter((bill) => bill.paidAt)
                  .sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""))
                  .slice(0, 3)
                  .map((bill) => (
                    <div className="activity-item" key={bill.id}>
                      <span className="activity-check"><Check size={14} /></span>
                      <div><strong>{bill.customerName}</strong><p>Marked paid · {bill.paidAt ? timeFormatter.format(new Date(bill.paidAt)) : ""}</p></div>
                    </div>
                  ))}
              </div>
            </section>

            <section className="counter-note">
              <p className="eyebrow">Counter shortcut</p>
              <h2>Search the last 6 digits.</h2>
              <p>When a customer only has the chassis number, the final six characters are enough.</p>
            </section>
          </aside>
        </div>
      </section>

      {selectedBill && (
        <BillDrawer
          bill={selectedBill}
          pdfUrl={selectedPdfUrl}
          onClose={() => setSelectedBill(null)}
          onPaid={() => void markPaid([selectedBill.id])}
          onUndo={() => void undoPaid([selectedBill.id])}
          onPrint={() => printBill(selectedBill)}
          onSave={(updated) => {
            if (supabase) {
              void supabase.from("bills").update({
                customer_name: updated.customerName,
                vehicle_no_display: updated.vehicleNo,
                vin: updated.vin,
                status: updated.status,
              }).eq("id", updated.id).then(async ({ error }) => {
                if (error) return setToast(error.message);
                await refreshLiveBills();
                setSelectedBill(null);
                setToast("Bill details updated");
              });
            } else {
              saveBills(bills.map((bill) => (bill.id === updated.id ? updated : bill)));
              setSelectedBill(updated);
              setToast("Bill details updated");
            }
          }}
        />
      )}

      {toast && <div className="toast"><CheckCircle2 size={18} />{toast}</div>}
    </main>
  );
}

function BillDrawer({
  bill,
  pdfUrl,
  onClose,
  onPaid,
  onUndo,
  onPrint,
  onSave,
}: {
  bill: Bill;
  pdfUrl: string | null;
  onClose: () => void;
  onPaid: () => void;
  onUndo: () => void;
  onPrint: () => void;
  onSave: (bill: Bill) => void;
}) {
  const [editing, setEditing] = useState(bill.status === "needs_review");
  const [form, setForm] = useState({ customerName: bill.customerName, vehicleNo: bill.vehicleNo, vin: bill.vin });

  const save = () => {
    const vin = normalizeIdentifier(form.vin);
    const vehicleNo = form.vehicleNo.trim();
    const complete = Boolean(form.customerName.trim() && vehicleNo && vin);
    onSave({
      ...bill,
      ...form,
      vin,
      vehicleNo,
      connectionKey: vin ? `VIN:${vin}` : vehicleNo ? `VEHICLE:${normalizeIdentifier(vehicleNo)}` : bill.connectionKey,
      connectionKeyType: vin ? "vin" : vehicleNo ? "vehicle" : bill.connectionKeyType,
      status: complete ? "ready" : "needs_review",
    });
    setEditing(false);
  };

  return (
    <div className="modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="bill-drawer print-sheet" role="dialog" aria-modal="true" aria-labelledby="bill-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><p className="eyebrow">Bill detail</p><h2 id="bill-title">{bill.invoiceReference || "Reference pending"}</h2></div>
          <button className="icon-button" type="button" aria-label="Close bill" onClick={onClose}><X size={20} /></button>
        </div>

        <div className={`document-preview ${pdfUrl ? "has-pdf" : ""}`}>
          {pdfUrl ? <PdfPages url={pdfUrl} pageFrom={bill.pageFrom} pageTo={bill.pageTo} /> : <>
            <div className="paper-mark"><FileText size={26} /></div>
            <strong>{bill.fileName}</strong>
            <span>Pages {bill.pageFrom}{bill.pageTo !== bill.pageFrom ? `–${bill.pageTo}` : ""}</span>
          </>}
          <button type="button" onClick={onPrint}><Printer size={17} /> Print selected bill</button>
        </div>

        <div className="detail-section">
          <div className="detail-section-title"><h3>Bill information</h3>{bill.status !== "paid" && !editing && <button type="button" onClick={() => setEditing(true)}><Pencil size={15} /> Edit</button>}</div>
          {editing ? (
            <div className="edit-grid">
              <label>Customer name<input value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })} /></label>
              <label>Vehicle number<input value={form.vehicleNo} onChange={(event) => setForm({ ...form, vehicleNo: event.target.value })} /></label>
              <label className="full-field">VIN<input value={form.vin} maxLength={17} onChange={(event) => setForm({ ...form, vin: event.target.value.toUpperCase() })} /></label>
              <div className="edit-actions"><button type="button" onClick={() => setEditing(false)}>Cancel</button><button type="button" onClick={save}>Save changes</button></div>
            </div>
          ) : (
            <dl className="details-grid">
              <div><dt>Customer</dt><dd>{bill.customerName || "Missing"}</dd></div>
              <div><dt>Vehicle number</dt><dd>{bill.vehicleNo || "Missing"}</dd></div>
              <div><dt>VIN</dt><dd>{bill.vin || "Missing"}</dd></div>
              <div><dt>Uploaded by</dt><dd>{bill.advisorName}</dd></div>
              <div className="full-field"><dt>Connection key</dt><dd>{bill.connectionKey}</dd></div>
            </dl>
          )}
        </div>

        <div className="drawer-footer">
          {bill.status === "paid" ? (
            <button className="undo-button" type="button" onClick={onUndo}><RotateCcw size={18} /> Undo paid status</button>
          ) : (
            <button className="paid-button" type="button" onClick={onPaid}><Check size={18} /> Mark as paid</button>
          )}
        </div>
      </section>
    </div>
  );
}

function PdfPages({ url, pageFrom, pageTo }: { url: string; pageFrom: number; pageTo: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const bytes = await fetch(url).then((response) => {
          if (!response.ok) throw new Error("Could not open the private PDF");
          return response.arrayBuffer();
        });
        const document = await pdfjs.getDocument({ data: bytes }).promise;
        if (!container.current || cancelled) return;
        container.current.replaceChildren();
        for (let pageNumber = pageFrom; pageNumber <= Math.min(pageTo, document.numPages); pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.2 });
          const canvas = window.document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.setAttribute("aria-label", `PDF page ${pageNumber}`);
          container.current?.appendChild(canvas);
          const context = canvas.getContext("2d");
          if (context) await page.render({ canvas, canvasContext: context, viewport }).promise;
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not preview this PDF");
      }
    };
    void render();
    return () => { cancelled = true; };
  }, [pageFrom, pageTo, url]);

  return error ? <p className="pdf-error">{error}</p> : <div className="pdf-pages" ref={container}><span>Preparing selected pages…</span></div>;
}

function LoadingScreen() {
  return (
    <main className="auth-screen">
      <div className="loading-mark"><FileSearch size={24} /></div>
      <p>Opening the service desk…</p>
    </main>
  );
}

function LoginScreen({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError(authError.message);
    setBusy(false);
  };

  return (
    <main className="auth-screen">
      <section className="login-card">
        <div className="brand login-brand"><span className="brand-mark"><FileSearch size={19} /></span><span>Service<span>Desk</span></span></div>
        <p className="eyebrow">Staff access</p>
        <h1>Find the bill.<br />Keep the queue moving.</h1>
        <p className="login-copy">Sign in with the account created for your service desk.</p>
        <form onSubmit={login}>
          <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<ChevronRight size={17} /></button>
        </form>
      </section>
      <aside className="login-aside">
        <div><p className="eyebrow">Built for the 6 PM rush</p><strong>VIN. Vehicle. Name.</strong><span>One search box replaces the WhatsApp scroll.</span></div>
      </aside>
    </main>
  );
}

function AccessError({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="auth-screen">
      <section className="login-card compact-card">
        <span className="review-icon"><UserRound size={20} /></span>
        <h1>Profile required</h1>
        <p className="login-copy">This login does not have a service advisor or cashier profile yet. Ask the project owner to create one.</p>
        <button className="plain-action" type="button" onClick={onSignOut}>Sign out</button>
      </section>
    </main>
  );
}

type ReviewBill = {
  id: string;
  customer_name: string;
  vehicle_no_display: string;
  vin: string;
  invoice_reference: string | null;
  status: Bill["status"];
  page_from: number;
  page_to: number;
};

function AdvisorPortal({
  supabase,
  token,
  profileName,
}: {
  supabase: SupabaseClient;
  token: string;
  profileName: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ uploadId: string; bills: ReviewBill[]; hasReadableText: boolean; hasDuplicateWarning: boolean } | null>(null);
  const [duplicateAccepted, setDuplicateAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const processFile = async () => {
    if (!file) return setMessage("Choose a PDF first.");
    setBusy(true);
    setMessage("Securing upload…");
    try {
      const initResponse = await fetch("/api/uploads/init", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: file.name, size: file.size, type: file.type }),
      });
      const init = await initResponse.json();
      if (!initResponse.ok) throw new Error(init.error);

      setMessage("Uploading PDF…");
      const { error: uploadError } = await supabase.storage
        .from("bills")
        .uploadToSignedUrl(init.path, init.token, file, { contentType: "application/pdf" });
      if (uploadError) throw uploadError;

      setMessage("Reading bill details…");
      const processResponse = await fetch(`/api/uploads/${init.uploadId}/process`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await processResponse.json();
      if (!processResponse.ok) throw new Error(result.error);
      setDuplicateAccepted(false);
      setPreview({
        uploadId: init.uploadId,
        bills: result.bills,
        hasReadableText: result.hasReadableText,
        hasDuplicateWarning: Boolean(result.duplicateWarning),
      });
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not process this PDF.");
    } finally {
      setBusy(false);
    }
  };

  const updatePreview = (index: number, field: keyof Pick<ReviewBill, "customer_name" | "vehicle_no_display" | "vin" | "invoice_reference">, value: string) => {
    if (!preview) return;
    setPreview({ ...preview, bills: preview.bills.map((bill, billIndex) => billIndex === index ? { ...bill, [field]: value } : bill) });
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setMessage("Saving corrections…");
    try {
      for (const bill of preview.bills) {
        const status = bill.customer_name && bill.vehicle_no_display && bill.vin ? "ready" : "needs_review";
        const { error } = await supabase.from("bills").update({
          customer_name: bill.customer_name.trim(),
          vehicle_no_display: bill.vehicle_no_display.trim(),
          vin: normalizeIdentifier(bill.vin),
          invoice_reference: bill.invoice_reference?.trim() || null,
          status,
        }).eq("id", bill.id);
        if (error) throw error;
      }
      const response = await fetch(`/api/uploads/${preview.uploadId}/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setPreview(null);
      setFile(null);
      setMessage("Upload confirmed. The cashier can see it now.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not confirm this upload.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="advisor-screen">
      <header className="advisor-topbar">
        <div className="brand"><span className="brand-mark"><FileSearch size={19} /></span><span>Service<span>Desk</span></span></div>
        <div className="user-block"><div className="avatar">{initials(profileName)}</div><div><strong>{profileName}</strong><span>Service advisor</span></div></div>
        <button className="icon-button" type="button" aria-label="Sign out" onClick={() => void supabase.auth.signOut()}><LogOut size={18} /></button>
      </header>
      <section className="advisor-content">
        <div className="advisor-heading"><p className="eyebrow">Advisor upload</p><h1>Send bills to the counter.</h1><p>Upload a digital PDF, check what was found, then confirm it.</p></div>
        {!preview ? (
          <section className="advisor-upload-card">
            <label className={`drop-zone ${file ? "has-file" : ""}`}>
              <input type="file" accept="application/pdf,.pdf" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setMessage(""); }} />
              <span><Upload size={23} /></span>
              <strong>{file?.name ?? "Choose a bill PDF"}</strong>
              <small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "Digital PDF · maximum 10 MB"}</small>
            </label>
            {message && <p className="advisor-message">{message}</p>}
            <button className="primary-button wide-button" type="button" disabled={busy || !file} onClick={() => void processFile()}>{busy ? "Working…" : "Upload and read bill"}<ChevronRight size={17} /></button>
          </section>
        ) : (
          <section className="review-sheet">
            <div className="section-heading"><div><p className="eyebrow">Extraction result</p><h2>{preview.bills.length} {preview.bills.length === 1 ? "bill" : "bills"} found</h2></div><span>{preview.hasReadableText ? "Text read successfully" : "Manual entry needed"}</span></div>
            {preview.bills.map((bill, index) => (
              <div className="review-bill" key={bill.id}>
                <div className="review-bill-title"><span>{index + 1}</span><strong>{bill.invoice_reference || `Bill ${index + 1}`}</strong><small>Pages {bill.page_from}–{bill.page_to}</small></div>
                <div className="edit-grid">
                  <label>Customer name<input value={bill.customer_name} onChange={(event) => updatePreview(index, "customer_name", event.target.value)} /></label>
                  <label>Vehicle number<input value={bill.vehicle_no_display} onChange={(event) => updatePreview(index, "vehicle_no_display", event.target.value)} /></label>
                  <label>VIN<input maxLength={17} value={bill.vin} onChange={(event) => updatePreview(index, "vin", event.target.value.toUpperCase())} /></label>
                  <label>Invoice / job card<input value={bill.invoice_reference ?? ""} onChange={(event) => updatePreview(index, "invoice_reference", event.target.value)} /></label>
                </div>
              </div>
            ))}
            {preview.hasDuplicateWarning && (
              <label className="duplicate-warning">
                <input type="checkbox" checked={duplicateAccepted} onChange={(event) => setDuplicateAccepted(event.target.checked)} />
                <span><strong>Possible duplicate found</strong><small>I checked the existing bill and still want to upload this copy.</small></span>
              </label>
            )}
            {message && <p className="advisor-message">{message}</p>}
            <div className="modal-actions"><button type="button" onClick={() => setPreview(null)}>Start over</button><button type="button" disabled={busy || (preview.hasDuplicateWarning && !duplicateAccepted)} onClick={() => void confirm()}><Check size={17} /> {busy ? "Confirming…" : "Confirm for cashier"}</button></div>
          </section>
        )}
      </section>
    </main>
  );
}
