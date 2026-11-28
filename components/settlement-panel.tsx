"use client";
import { useRef, useState } from "react";
import { balance, billAmount, billType, collected, indiaDate, isPaid, isSupportingNote, money, paymentMethods, paymentReferenceLabel, type DeskBill, type Snapshot, type Staff } from "@/lib/desk";
import { payerBalance, payerCollected, rupees, sameCustomerBills, sameVehicleBills, settlementStatus, type SettlementDetails } from "@/lib/settlement";

type Submit = (body: { action: string; [key: string]: unknown }) => Promise<boolean | undefined>;
export function SettlementPanel({ bill, snapshot, actor, busy, onSubmit, onOpenBill }: { bill: DeskBill; snapshot: Snapshot; actor: Staff; busy: boolean; onSubmit: Submit; onOpenBill: (id: string) => void }) {
  const [mode, setMode] = useState("collect");
  const payer = "customer";
  const [excluded, setExcluded] = useState<string[]>([]);
  const [shares, setShares] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [otherMethod, setOtherMethod] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState<SettlementDetails>({ approvedOn: indiaDate(), responsibleStaff: actor.full_name });
  const request = useRef({ fingerprint: "", id: "" });
  const related = mode === "collect" ? sameCustomerBills(bill, snapshot.bills) : sameVehicleBills(bill, snapshot.bills);
  const candidates = related.filter(b => b.uploads?.confirmed_at && b.amount_paise !== null && b.invoice_date && b.invoice_reference?.trim() && !isSupportingNote(b) && !isPaid(b, snapshot.payments) && (mode === "collect" ? (payerBalance(b, snapshot.payments, payer) ?? 0) > 0 : !b.settlement || b.settlement.revoked));
  const selected = candidates.filter(b => !excluded.includes(b.id));
  const amountFor = (b: DeskBill) => mode === "insurance" ? Math.max(0, (() => { try { return rupees(shares[b.id] || "0"); } catch { return 0; } })() - payerCollected(b, snapshot.payments, "customer")) : payerBalance(b, snapshot.payments, payer) ?? 0;
  const total = selected.reduce((sum, b) => sum + amountFor(b), 0);
  const paidNow = amount === "" ? mode === "credit" ? 0 : total : (() => { try { return rupees(amount); } catch { return NaN; } })();
  const entries = selected.map((b, index) => { const allocation = Math.min(Math.max(0, paidNow - selected.slice(0, index).reduce((sum, previous) => sum + amountFor(previous), 0)), amountFor(b)); return { billId: b.id, amountPaise: allocation, ...(mode === "insurance" ? { customerSharePaise: (() => { try { return rupees(shares[b.id] || "0"); } catch { return NaN; } })() } : {}) }; });
  const referenceLabel = paymentReferenceLabel(method);
  const paysInFull = mode === "collect" && selected.length > 0 && paidNow === total && selected.every(b => amountFor(b) === balance(b, snapshot.payments));
  const changeDetail = (key: keyof SettlementDetails, value: string) => setDetails(current => ({ ...current, [key]: value }));
  async function submit() {
    setError("");
    try {
      if (!selected.length) throw new Error("Select at least one bill");
      if (!Number.isSafeInteger(paidNow) || paidNow < 0 || paidNow > total) throw new Error("Amount received must fit the selected balance");
      if (mode === "insurance" && selected.some(b => !shares[b.id]?.trim())) throw new Error("Enter the customer share for each insurance invoice (zero is allowed)");
      const body = { action: mode === "collect" ? "collect_batch" : "arrange", entries: mode === "collect" ? entries.filter(e => e.amountPaise > 0) : entries, payer, kind: mode === "collect" ? undefined : mode, details, method, otherMethod, transactionId: reference };
      const fingerprint = JSON.stringify(body);
      if (request.current.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      if (await onSubmit({ ...body, requestId: request.current.id })) { request.current = { fingerprint: "", id: "" }; setAmount(""); setMode("collect"); setExcluded([]); setMethod(""); setOtherMethod(""); setReference(""); }
    } catch (e) { setError((e as Error).message); }
  }
  const settlement = bill.settlement;
  return <section className="sd-settlement">
    {actor.role === "cashier" && !isSupportingNote(bill) && <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3>Customer collection</h3><p>{bill.customer_name}{bill.customer_reference ? " · Customer ID " + bill.customer_reference : ""}</p>
      <div className="sd-settlement-fields"><label>Collection type<select disabled={busy} value={mode} onChange={e => { setMode(e.target.value); setAmount(""); setExcluded([]); }}><option value="collect">Collect payment</option><option value="insurance">Insurance customer share</option><option value="credit">Credit form · service</option></select></label>
      </div>
      <section className="sd-related sd-collection-bills" aria-label="Customer bill selection"><h3>This customer’s bills</h3><p>{mode === "collect" ? "Select the bills to pay together. The amount updates with your selection." : "Select bills for this vehicle’s arrangement."}</p>
      <div className="sd-actions"><strong aria-live="polite">{selected.length} bill{selected.length === 1 ? "" : "s"} selected · {money(total)}</strong><button type="button" disabled={busy || !candidates.length} onClick={() => { setExcluded(selected.length === candidates.length ? candidates.map(b => b.id) : []); setAmount(""); }}>{selected.length === candidates.length ? "Clear selection" : "Select all outstanding bills"}</button></div>
      <div className="sd-allocations">{(mode === "collect" ? related : candidates).map(b => {
        const eligible = candidates.includes(b);
        const checked = eligible && !excluded.includes(b.id);
        const unavailable = !b.uploads?.confirmed_at ? "Not submitted" : isSupportingNote(b) ? "No collection required" : isPaid(b, snapshot.payments) ? "Paid in full" : b.amount_paise === null || !b.invoice_date || !b.invoice_reference?.trim() ? "Bill details need review" : `No ${payer} balance due`;
        return <div className="sd-allocation" key={b.id} data-selected={checked}><label className="sd-bill-check"><input type="checkbox" aria-label={`Select bill ${b.invoice_reference || b.id}`} disabled={busy || !eligible} checked={checked} onChange={e => { setExcluded(current => e.target.checked ? current.filter(id => id !== b.id) : [...current, b.id]); setAmount(""); }}/><span><strong>{b.invoice_reference || "Invoice not read"}</strong><small>{billType(b)}</small><small>{b.invoice_date || "Date not read"} · {b.vehicle_no_display || "Vehicle not read"}</small><small>{eligible ? settlementStatus(b, snapshot.payments) : unavailable}</small></span></label>
        {mode === "insurance" ? <label>Customer share (₹)<input aria-label={`Customer share ${b.invoice_reference}`} type="number" min="0" max={(b.amount_paise ?? 0) / 100} step="0.01" required={checked} disabled={busy} value={shares[b.id] ?? ""} onChange={e => setShares(current => ({ ...current, [b.id]: e.target.value }))}/></label> : <strong>{eligible ? money(payerBalance(b, snapshot.payments, payer)) : billAmount(b)}</strong>}
        {checked && <small>Collect now: {money(entries.find(e => e.billId === b.id)?.amountPaise || 0)}</small>}
        <button type="button" disabled={busy} aria-label={`Open bill ${b.invoice_reference || b.id}`} onClick={() => onOpenBill(b.id)}>View bill</button>
      </div>; })}</div></section>
      {!candidates.length && <p className="sd-muted">No eligible outstanding bills for this collection type.</p>}
      {mode !== "collect" && <fieldset className={mode === "credit" ? "sd-credit-fields" : "sd-insurance-fields"}><legend>{mode === "credit" ? "CREDIT FORM – SERVICE" : "Insurance arrangement"}</legend><div className="sd-settlement-fields">
        {mode === "insurance" && <label>Insurer<input required maxLength={200} disabled={busy} value={details.insurer || ""} onChange={e => changeDetail("insurer", e.target.value)}/></label>}
        <label>Contact person<input maxLength={200} disabled={busy} value={details.contactPerson || ""} onChange={e => changeDetail("contactPerson", e.target.value)}/></label>
        <label>Contact number<input type="tel" maxLength={40} disabled={busy} value={details.contactNumber || ""} onChange={e => changeDetail("contactNumber", e.target.value)}/></label>
        <label>Responsible staff<input maxLength={200} disabled={busy} value={details.responsibleStaff || ""} onChange={e => changeDetail("responsibleStaff", e.target.value)}/></label>
        {mode === "credit" && <><label>Approved by (outside approval)<input required maxLength={200} disabled={busy} value={details.approvedBy || ""} onChange={e => changeDetail("approvedBy", e.target.value)}/></label><label>Approval date<input required type="date" disabled={busy} value={details.approvedOn || ""} onChange={e => changeDetail("approvedOn", e.target.value)}/></label><label>Credit due date<input required type="date" min={details.approvedOn} disabled={busy} value={details.dueDate || ""} onChange={e => changeDetail("dueDate", e.target.value)}/></label></>}
        <label>Remarks<textarea maxLength={1000} disabled={busy} value={details.remarks || ""} onChange={e => changeDetail("remarks", e.target.value)}/></label>
      </div></fieldset>}
      <div className="sd-collection-total"><span>{mode === "insurance" ? "Customer share remaining" : "Selected balance"}</span><strong>{money(total)}</strong></div>
      <label>Amount received now (₹)<input type="number" min="0" max={total / 100} step="0.01" disabled={busy} value={amount === "" ? String((mode === "credit" ? 0 : total) / 100) : amount} onChange={e => setAmount(e.target.value)}/></label>
      {mode === "credit" && <p>Credit allowed: <strong>{money(total - (Number.isFinite(paidNow) ? paidNow : 0))}</strong>. Payments are allocated to the oldest selected invoice first.</p>}
      {mode === "insurance" && <p>The insurer balance remains receivable. The customer share must be collected before vehicle release.</p>}
      {paidNow > 0 && <div className="sd-settlement-fields"><label>Mode of payment<select required disabled={busy} value={method} onChange={e => { setMethod(e.target.value); setReference(""); setOtherMethod(""); }}><option value="">Select payment method</option>{paymentMethods.map(m => <option key={m}>{m}</option>)}</select></label>
        {method === "Other" && <label>Specify other payment method<input required maxLength={100} disabled={busy} value={otherMethod} onChange={e => setOtherMethod(e.target.value)}/></label>}
        {referenceLabel && <label>{referenceLabel} (required)<input required maxLength={100} disabled={busy} value={reference} onChange={e => setReference(e.target.value)}/></label>}
      </div>}
      {error && <p role="alert" className="sd-warning">{error}</p>}
      <button className="sd-primary" disabled={busy || !selected.length || !Number.isFinite(paidNow) || paidNow < 0 || paidNow > total || (mode === "collect" && paidNow === 0) || (paidNow > 0 && (!method || Boolean(referenceLabel && !reference.trim()) || (method === "Other" && !otherMethod.trim())))}>{mode === "collect" ? paysInFull ? "Mark selected bills as paid" : "Record payment" : mode === "credit" ? "Save approved credit" : "Save insurance arrangement"} · {money(Number.isFinite(paidNow) ? paidNow : 0)}</button>
    </form>}
    {settlement && <SettlementRecord key={settlement.id + JSON.stringify(settlement.details)} bill={bill} snapshot={snapshot} actor={actor} busy={busy} onSubmit={onSubmit}/>}
  </section>;
}
function SettlementRecord({ bill, snapshot, actor, busy, onSubmit }: { bill: DeskBill; snapshot: Snapshot; actor: Staff; busy: boolean; onSubmit: Submit }) {
  const s = bill.settlement!;
  const [details, setDetails] = useState(s.details);
  const related = snapshot.bills.filter(b => b.settlement?.id === s.id);
  async function update(action: string) {
    const reason = action === "revoke_settlement" ? window.prompt("Reason for revoking this approval:") : undefined;
    if (action === "revoke_settlement" && !reason?.trim()) return;
    await onSubmit({ action, requestId: crypto.randomUUID(), settlementId: s.id, entries: [], payer: "customer", details: action === "revoke_settlement" ? { remarks: reason } : { followup1: details.followup1 || "", followup2: details.followup2 || "", remarks: details.remarks || "" } });
  }
  return <section className={s.kind === "credit" ? "sd-credit-sheet" : "sd-insurance-sheet"}>
    <header><h3>{s.kind === "credit" ? "CREDIT FORM – SERVICE" : "INSURANCE RECEIVABLE"}</h3><strong>SL. No. {String(s.number).padStart(5, "0")}</strong></header>
    <p>{s.revoked ? "APPROVAL REVOKED" : s.kind === "credit" ? "Outside approval recorded" : "Customer / insurer split"}</p>
    <dl className="sd-form-details"><div><dt>Customer name</dt><dd>{bill.customer_name}</dd></div><div><dt>Regn. No.</dt><dd>{bill.vehicle_no_display}</dd></div><div><dt>VIN</dt><dd>{bill.vin || "—"}</dd></div><div><dt>Contact person</dt><dd>{s.details.contactPerson || "—"}</dd></div><div><dt>Contact No.</dt><dd>{s.details.contactNumber || "—"}</dd></div><div><dt>Staff</dt><dd>{s.details.responsibleStaff || "—"}</dd></div>{s.kind === "insurance" && <div><dt>Insurer</dt><dd>{s.details.insurer}</dd></div>}</dl>
    <div className="sd-table-wrap"><table><thead><tr><th>Inv. No. / Date</th><th>Inv. Amt.</th><th>Rcvd. Amt.</th><th>Balance</th></tr></thead><tbody>{related.map(b => <tr key={b.id}><td>{b.invoice_reference}<small>{b.invoice_date}</small></td><td>{money(b.amount_paise)}</td><td>{money(collected(b, snapshot.payments))}</td><td>{money(balance(b, snapshot.payments))}</td></tr>)}</tbody></table></div>
    <dl className="sd-form-details">{s.kind === "credit" && <><div><dt>Credit allowed</dt><dd>{money(related.reduce((sum, b) => sum + (b.credit_limit_paise || 0), 0))}</dd></div><div><dt>Approved by</dt><dd>{s.details.approvedBy} · {s.details.approvedOn}</dd></div><div><dt>Due date</dt><dd>{s.details.dueDate}</dd></div></>}<div><dt>Recorded by</dt><dd>{snapshot.staff.find(p => p.id === s.recorded_by)?.full_name || "Former staff"} · {indiaDate(s.created_at)}</dd></div></dl>
    <div className="sd-settlement-fields">{(["followup1", "followup2", "remarks"] as const).map((key, index) => <label key={key}>{index < 2 ? `Follow up ${index + 1}` : "Remarks"}<textarea disabled={busy} maxLength={1000} value={details[key] || ""} onChange={e => setDetails(current => ({ ...current, [key]: e.target.value }))}/></label>)}</div>
    <div className="sd-actions sd-no-print"><button disabled={busy} onClick={() => void update("update_settlement")}>Save follow-ups</button><button onClick={() => window.print()}>Print {s.kind === "credit" ? "credit form" : "receivable"}</button>{actor.role === "super_admin" && !s.revoked && <button className="sd-danger" disabled={busy} onClick={() => void update("revoke_settlement")}>Revoke approval</button>}</div>
  </section>;
}
