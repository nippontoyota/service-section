"use client";
import { useRef, useState } from 'react';
import { balance, collected, customerKey, indiaDate, money, type DeskBill, type Snapshot, type Staff } from '@/lib/desk';
import { approvalState, arrangementApproved, type ApprovalEntry } from '@/lib/approval';
import { payerBalance, rupees, vehicleKey, type SettlementDetails } from '@/lib/settlement';

type Submit = (body: { action: string; [key: string]: unknown }) => Promise<boolean | undefined>;
const dateTime = (value: string) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
export function ApprovalPanel({ bill, snapshot, actor, busy, onSubmit, demo = false, initialKind, formOnly = false, onSaved, onViewBill }: { bill: DeskBill; snapshot: Snapshot; actor: Staff; busy: boolean; onSubmit: Submit; demo?: boolean; initialKind?: 'insurance' | 'credit'; formOnly?: boolean; onSaved?: () => void; onViewBill?: (bill: DeskBill) => void }) {
  const s = bill.settlement, state = s ? approvalState(s) : undefined;
  const kind = initialKind || s?.kind || bill.payment_route || 'ordinary';
  const [details, setDetails] = useState<SettlementDetails>({
    responsibleStaffId: actor.id, responsibleStaff: actor.full_name,
    contactPerson: kind === 'insurance' ? '' : bill.customer_name, contactNumber: kind === 'insurance' ? '' : bill.customer_phone || bill.field_confidence?.document?.customerPhone || '',
    insurer: /insur|assurance/i.test(bill.field_confidence?.document?.billedTo || '') ? bill.field_confidence?.document?.billedTo : '',
    ...s?.details,
  });
  const related = snapshot.bills.filter(b => s && !s.revoked ? b.settlement?.id === s.id : b.uploaded_by === actor.id && b.amount_paise !== null && !b.gate_completed && (!b.settlement || b.settlement.revoked) && (!collected(b, snapshot.payments) || b.settlement?.revoked) && customerKey(b) === customerKey(bill) && (b.id === bill.id || (vehicleKey(bill.vehicle_no_display) && vehicleKey(b.vehicle_no_display) === vehicleKey(bill.vehicle_no_display))));
  const [selected, setSelected] = useState<string[]>(s && !s.revoked ? related.map(b => b.id) : [bill.id]);
  const savedAmounts = Object.fromEntries((s?.proposal || []).map(e => [e.billId, String((s?.kind === 'insurance' ? (related.find(b => b.id === e.billId)?.amount_paise || 0) - (e.insurerPaise || 0) : e.creditPaise || 0) / 100)]));
  const [amounts, setAmounts] = useState<Record<string, string>>(savedAmounts);
  const [editingTerms, setEditingTerms] = useState(false), [rejecting, setRejecting] = useState(false);
  const amountFor = (b: DeskBill) => amounts[b.id] ?? String((kind === 'insurance' ? Math.min(200000, b.amount_paise || 0) : balance(b, snapshot.payments) || 0) / 100);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [followup, setFollowup] = useState({ contact: s?.details.contactPerson || '', note: '', promisedDate: '', nextDate: '' });
  const request = useRef({ fingerprint: '', id: '' });
  const editable = actor.role === 'service_advisor' ? !s || ['draft', 'returned', 'revoked'].includes(state!) : actor.role === 'team_leader' && state === 'pending' && editingTerms;
  const change = (key: keyof SettlementDetails, value: string) => setDetails(d => ({ ...d, [key]: value }));
  async function send(action: string) {
    setError('');
    try {
      const editing = ['save_request', 'approve_request'].includes(action);
      const entries: ApprovalEntry[] = editing ? related.filter(b => selected.includes(b.id)).map(b => {
        const amount = rupees(amountFor(b));
        if (amount > (b.amount_paise || 0)) throw new Error('Requested amount must fit invoice total');
        return { billId: b.id, [kind === 'insurance' ? 'insurerPaise' : 'creditPaise']: kind === 'insurance' ? (b.amount_paise || 0) - amount : amount };
      }) : [];
      const body = { action, target: bill.id, settlementId: s && !s.revoked ? s.id : undefined, revision: s && !s.revoked ? s.revision : undefined, kind, entries, details, reason, followup };
      const fingerprint = JSON.stringify(body);
      if (request.current.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      if (await onSubmit({ ...body, requestId: request.current.id })) { request.current = { fingerprint: '', id: '' }; setFollowup(f => ({ ...f, note: '' })); if (action === 'save_request' || action === 'submit_request') onSaved?.(); }
    } catch (e) { setError((e as Error).message); }
  }
  if (kind === 'ordinary' || (!s && actor.role !== 'service_advisor')) return null;
  return <section className={"sd-approval-sheet" + (formOnly ? " sd-approval-form-only" : "")}>
    <header className="sd-section-heading"><div><span className="sd-eyebrow">{s ? `REQUEST ${String(s.number).padStart(5, '0')}` : 'PAYMENT ROUTE'}</span><h3>{kind === 'insurance' ? 'Insurance approval' : 'Credit form – service'}</h3></div>{s && <span className="sd-status">{state?.replaceAll('_', ' ')}</span>}</header>
    {s?.approved_name && <div className={'sd-verified-stamp' + (s.revoked ? ' is-revoked' : '')}><strong>{s.revoked ? 'APPROVAL REVOKED' : 'VERIFIED'}</strong><span>Signed by {s.approved_name}</span><small>Team Leader · {dateTime(s.approved_at!)} · Request {String(s.number).padStart(5, '0')}</small></div>}
    {state === 'legacy_approved' && <p className="sd-muted">Legacy approval retained. No Team Leader signature was recorded.</p>}
    {state === 'pending' && actor.role !== 'team_leader' && <p className="sd-alert">Awaiting the branch Team Leader. Cashier collection and release are blocked.</p>}
    {state === 'returned' && <p className="sd-warning">Returned: {s?.return_reason}</p>}
    {!snapshot.staff.some(p => p.role === 'team_leader' && p.active && !p.must_change_password) && actor.role === 'service_advisor' && <p className="sd-warning">The administrator must set up an active Team Leader. Requests will remain pending until then.</p>}
    <dl className={"sd-form-details" + (actor.role === 'team_leader' ? ' sd-print-only' : '')}><div><dt>Customer / ID</dt><dd>{bill.customer_name} · {bill.customer_reference || '—'}</dd></div><div><dt>Customer contact</dt><dd>{bill.customer_phone || bill.field_confidence?.document?.customerPhone || "Not recorded"}</dd></div><div><dt>Vehicle / VIN</dt><dd>{bill.vehicle_no_display} · {bill.vin || '—'}</dd></div><div><dt>Submitted by</dt><dd>{s?.advisor_name || snapshot.staff.find(p => p.id === bill.uploaded_by)?.full_name || actor.full_name}</dd></div><div><dt>Prepared</dt><dd>{s ? dateTime(s.created_at) : indiaDate()}</dd></div></dl>
    {editable ? <form onSubmit={e => { e.preventDefault(); void send(actor.role === 'team_leader' ? 'approve_request' : 'save_request'); }}>
      <>
        <p>{actor.role === 'team_leader' ? 'Review and correct the terms below. Your approval records the final version.' : 'Save this form before submitting the upload. Amounts shown here are requests, not money received.'}</p>
        <div className="sd-settlement-fields">
          {kind === 'insurance' && <label>Insurer<input maxLength={200} value={details.insurer || ''} disabled={busy} onChange={e => change('insurer', e.target.value)}/></label>}
          <label>{kind === 'insurance' ? 'Insurer contact person' : 'Customer contact person'}<input maxLength={200} value={details.contactPerson || ''} disabled={busy} onChange={e => change('contactPerson', e.target.value)}/></label>
          <label>Contact number<input type="tel" maxLength={40} value={details.contactNumber || ''} disabled={busy} onChange={e => change('contactNumber', e.target.value)} placeholder="Required before submission"/></label>
          <label>Responsible staff<select value={details.responsibleStaffId || ''} disabled={busy} onChange={e => change('responsibleStaffId', e.target.value)}><option value="">Select advisor</option>{snapshot.staff.filter(p => p.active && p.role === 'service_advisor').map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
          <label>{kind === 'insurance' ? 'Expected insurer payment date' : 'Credit due date'}<input type="date" min={indiaDate()} value={details.dueDate || ''} disabled={busy} onChange={e => change('dueDate', e.target.value)}/></label>
        </div>
        <div className="sd-allocations">{related.map(b => <div className="sd-approval-invoice" key={b.id}><label><input type="checkbox" checked={selected.includes(b.id)} disabled={busy || Boolean(s && !s.revoked)} onChange={e => setSelected(v => e.target.checked ? [...v, b.id] : v.filter(id => id !== b.id))}/>{b.invoice_reference} · {money(b.amount_paise)}<small>{b.invoice_date} · Job {b.job_card_reference || '—'} · {b.vehicle_no_display}</small></label>
          <label>{kind === 'insurance' ? 'Customer pays (₹)' : 'Requested credit (₹)'}<input type="number" min="0" step="0.01" max={(b.amount_paise || 0) / 100} disabled={busy || !selected.includes(b.id)} value={amountFor(b)} onChange={e => setAmounts(v => ({ ...v, [b.id]: e.target.value }))}/></label>
          <small>{kind === 'insurance' ? 'Insurer pays' : 'Required at cashier'}: {money(Math.max(0, (kind === 'insurance' ? b.amount_paise || 0 : balance(b, snapshot.payments) || 0) - Math.round(Number(amountFor(b)) * 100)))}</small>
        </div>)}</div>
        <label>Reason / remarks<textarea maxLength={1000} value={details.remarks || ''} disabled={busy} onChange={e => change('remarks', e.target.value)}/></label>
      </>
      <button className="sd-primary sd-no-print" disabled={busy || !selected.length}>{actor.role === 'team_leader' ? 'Approve final terms' : 'Save request draft'}</button>
    </form> : s && <>
      <dl className="sd-form-details">{[['Insurer', s.details.insurer], ['Contact person', s.details.contactPerson], ['Contact number', s.details.contactNumber], ['Responsible staff', s.details.responsibleStaff], ['Due date', s.details.dueDate], ['Remarks', s.details.remarks]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="sd-request-amounts">{related.map(b => <article key={b.id}><div><strong>{b.invoice_reference}</strong><small>{b.job_card_reference || '—'} · {b.invoice_date}</small></div><div><small>Bill total</small><strong>{money(b.amount_paise)}</strong></div><div><small>{s.kind === 'insurance' ? 'Customer pays' : 'Credit allowed'}</small><strong>{money(s.kind === 'insurance' ? (b.amount_paise || 0) - (s.proposal?.find(e => e.billId === b.id)?.insurerPaise ?? (b.amount_paise || 0) - (b.customer_share_paise || 0)) : s.proposal?.find(e => e.billId === b.id)?.creditPaise ?? b.credit_limit_paise ?? 0)}</strong></div>{related.length > 1 && onViewBill && <button aria-label={`View bill ${b.invoice_reference}`} onClick={() => onViewBill(b)}>View bill</button>}</article>)}</div>
    </>}
    {actor.role === 'service_advisor' && s && ['draft', 'returned'].includes(state!) && related.every(b => b.uploads?.confirmed_at) && <button disabled={busy} className="sd-primary sd-no-print" onClick={() => void send('submit_request')}>Submit saved draft to TL</button>}
    {actor.role === 'team_leader' && state === 'pending' && <div className="sd-no-print">
      <div className="sd-actions">{editingTerms ? <button disabled={busy} onClick={() => { setDetails({ ...s?.details }); setAmounts(savedAmounts); setEditingTerms(false); }}>Cancel edit</button> : <><button className="sd-primary" disabled={busy || rejecting} onClick={() => void send('approve_request')}>Approve</button><button disabled={busy} onClick={() => { setEditingTerms(true); setRejecting(false); }}>Edit</button></>}<button disabled={busy} onClick={() => setRejecting(v => !v)}>{rejecting ? 'Cancel rejection' : 'Reject'}</button></div>
      {rejecting && <div className="sd-rejection"><label>Rejection reason<textarea maxLength={1000} disabled={busy} value={reason} onChange={e => setReason(e.target.value)}/></label><small>This sends the request back to the advisor for correction.</small><button disabled={busy || !reason.trim()} onClick={() => void send('return_request')}>Reject and return</button></div>}
    </div>}
    {actor.role === 'cashier' && state === 'approved' && !s?.acknowledged_at && <button className="sd-primary sd-no-print" disabled={busy} onClick={() => void send('acknowledge_request')}>Accept TL-approved terms</button>}
    {s && !formOnly && <div className="sd-actions sd-no-print"><button onClick={() => window.print()}>Print form</button>{s.kind === 'insurance' && s.approved_name && !demo && <a className="sd-secondary" target="_blank" rel="noreferrer" href={`/api/bills/${bill.id}/approved-pdf`}>View stamped insurer bill PDF</a>}{actor.role === 'super_admin' && !s.revoked && <button className="sd-danger" disabled={busy} onClick={() => { const reason = window.prompt('Reason for revoking this approval'); if (reason?.trim()) void onSubmit({ action: 'revoke_settlement', requestId: crypto.randomUUID(), settlementId: s.id, entries: [], payer: 'customer', details: { remarks: reason } }); }}>Revoke approval</button>}</div>}
    {s && !formOnly && arrangementApproved(s) && <section className="sd-followups"><h4>Payment follow-up</h4><p>{s.kind === 'insurance' ? 'Insurer' : 'Customer'} outstanding: <strong>{money(related.reduce((sum, b) => sum + (payerBalance(b, snapshot.payments, s.kind === 'insurance' ? 'insurer' : 'customer') || 0), 0))}</strong></p>
      {(s.followups || []).map(f => <article className="sd-audit-row" key={f.id}><div><strong>{f.contact} · {f.actorName}</strong><p>{f.note}</p><small>{dateTime(f.createdAt)}{f.promisedDate && ` · Promised ${f.promisedDate}`}{f.nextDate && ` · Next follow-up ${f.nextDate}`}</small></div></article>)}
      {actor.role === 'team_leader' && arrangementApproved(s) && <form className="sd-no-print" onSubmit={e => { e.preventDefault(); void send('add_followup'); }}><div className="sd-settlement-fields"><label>Person contacted<input required maxLength={200} disabled={busy} value={followup.contact} onChange={e => setFollowup(f => ({ ...f, contact: e.target.value }))}/></label><label>Promised payment date<input type="date" disabled={busy} value={followup.promisedDate} onChange={e => setFollowup(f => ({ ...f, promisedDate: e.target.value }))}/></label><label>Next follow-up<input type="date" disabled={busy} value={followup.nextDate} onChange={e => setFollowup(f => ({ ...f, nextDate: e.target.value }))}/></label></div><label>Follow-up note<textarea required maxLength={1000} disabled={busy} value={followup.note} onChange={e => setFollowup(f => ({ ...f, note: e.target.value }))}/></label><button disabled={busy}>Add follow-up</button></form>}
    </section>}
    {error && <p role="alert" className="sd-warning">{error}</p>}
  </section>;
}

export function PaymentRoutePicker({ bill, busy, onChoose }: { bill: DeskBill; busy: boolean; onChoose: (route: 'ordinary' | 'insurance' | 'credit') => void }) {
  const activeRequest = bill.settlement && !bill.settlement.revoked;
  const route = activeRequest ? bill.settlement!.kind : bill.payment_route || '';
  return <div className="sd-payment-route-picker">
    <label><span>Payment type</span><select aria-label={`Payment type for ${bill.invoice_reference || 'bill'}`} disabled={busy} value={route} onChange={e => { if (e.target.value) onChoose(e.target.value as 'ordinary' | 'insurance' | 'credit'); }}>
      <option value="" disabled>Choose payment route</option>
      <option value="ordinary" disabled={Boolean(activeRequest || bill.uploads?.confirmed_at)}>Cash / full payment</option>
      <option value="insurance" disabled={Boolean(activeRequest && route !== 'insurance')}>Insurer</option>
      <option value="credit" disabled={Boolean(activeRequest && route !== 'credit')}>Credit form – service</option>
    </select></label>
    {activeRequest && <button className="sd-secondary" type="button" disabled={busy} onClick={() => onChoose(bill.settlement!.kind)}>Open {route === 'insurance' ? 'insurer' : 'credit'} form</button>}
    {route === 'ordinary' && <small>Saved · cashier collects payment</small>}
  </div>;
}

export function TeamLeaderWorkspace({ snapshot, onSelect, onViewBill }: { snapshot: Snapshot; onSelect: (id: string) => void; onViewBill: (bill: DeskBill) => void }) {
  const [tab, setTab] = useState('pending'), [kind, setKind] = useState(''), [advisor, setAdvisor] = useState(''), [query, setQuery] = useState(''), [due, setDue] = useState('');
  const cases = [...new Map(snapshot.bills.filter(b => b.settlement).map(b => [b.settlement!.id, b])).values()];
  const billsFor = (b: DeskBill) => snapshot.bills.filter(x => x.settlement?.id === b.settlement!.id);
  const outstanding = (b: DeskBill) => billsFor(b).reduce((sum, x) => sum + (balance(x, snapshot.payments) || 0), 0);
  const isIn = (b: DeskBill, view: string) => view === 'pending' || view === 'returned' ? approvalState(b.settlement!) === view : view === 'settled' ? arrangementApproved(b.settlement) && outstanding(b) === 0 : view === 'overdue' ? arrangementApproved(b.settlement) && outstanding(b) > 0 && Boolean(b.settlement!.details.dueDate && b.settlement!.details.dueDate < indiaDate()) : arrangementApproved(b.settlement) && outstanding(b) > 0;
  const rows = cases.filter(b => isIn(b, tab) && (!kind || b.settlement!.kind === kind) && (!advisor || b.settlement!.details.responsibleStaffId === advisor || (!b.settlement!.details.responsibleStaffId && b.uploaded_by === advisor)) && (!due || (b.settlement!.details.dueDate || '9999') <= due) && billsFor(b).some(x => [x.customer_name, x.vehicle_no_display, x.invoice_reference, x.customer_reference, b.settlement!.details.insurer].some(v => v?.toLowerCase().includes(query.toLowerCase()))));
  return <section className="sd-panel sd-tl-workspace"><h2>Approvals and payment follow-up</h2><div className="sd-tl-tabs" role="group" aria-label="Request views">{[['pending', 'Pending approval'], ['returned', 'Returned'], ['outstanding', 'Outstanding'], ['overdue', 'Overdue'], ['settled', 'Settled']].map(([value, label]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}<strong>{cases.filter(b => isIn(b, value)).length}</strong></button>)}</div>
    <label className="sd-tl-search">Search<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Customer, vehicle, invoice or insurer"/></label><details className="sd-disclosure"><summary>Filters</summary><div className="sd-filters"><label>Type<select value={kind} onChange={e => setKind(e.target.value)}><option value="">All types</option><option value="insurance">Insurance</option><option value="credit">Credit</option></select></label><label>Responsible advisor<select value={advisor} onChange={e => setAdvisor(e.target.value)}><option value="">All advisors</option>{snapshot.staff.filter(p => p.role === 'service_advisor').map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label><label>Due by<input type="date" value={due} onChange={e => setDue(e.target.value)}/></label></div></details>
    <div className="sd-tl-cases">{rows.map(b => { const s = b.settlement!, group = billsFor(b), last = s.followups?.at(-1); return <article className="sd-tl-case" key={s.id}>
      <div className="sd-tl-case-main"><button className="sd-invoice" onClick={() => onSelect(b.id)}>{s.kind === 'credit' ? 'Credit' : 'Insurance'} · {String(s.number).padStart(5, '0')}</button><h3>{b.customer_name}</h3><p>{b.vehicle_no_display} · {s.details.responsibleStaff || s.advisor_name}</p><small>{group.map(x => x.invoice_reference).join(', ')}</small></div>
      <div className="sd-tl-case-status"><strong>{money(outstanding(b))} outstanding</strong><small>Due {s.details.dueDate || 'not set'}</small>{last?.nextDate && <small>Follow-up {last.nextDate}</small>}</div>
      <div className="sd-actions"><button onClick={() => onViewBill(b)}>View bill</button><button className="sd-secondary" onClick={() => onSelect(b.id)}>Open</button></div>
    </article>; })}</div>{!rows.length && <p className="sd-muted">No requests in this view.</p>}
  </section>;
}
