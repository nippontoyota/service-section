"use client";
import { useRef, useState } from 'react';
import { balance, billAmount, isPaid, isSupportingNote, money, paymentMethods, paymentReferenceLabel, type DeskBill, type Snapshot, type Staff } from '@/lib/desk';
import { cashierAccessible } from '@/lib/approval';
import { payerBalance, rupees, sameCustomerBills } from '@/lib/settlement';
type Submit = (body: { action: string; [key: string]: unknown }) => Promise<boolean | undefined>;
export function SettlementPanel({ bill, snapshot, actor, busy, onSubmit, onOpenBill }: { bill: DeskBill; snapshot: Snapshot; actor: Staff; busy: boolean; onSubmit: Submit; onOpenBill: (id: string) => void }) {
  const [payer, setPayer] = useState<'customer' | 'insurer'>('customer');
  const [excluded, setExcluded] = useState<string[]>([]), [amount, setAmount] = useState(''), [method, setMethod] = useState(''), [otherMethod, setOtherMethod] = useState(''), [reference, setReference] = useState(''), [error, setError] = useState('');
  const request = useRef({ fingerprint: '', id: '' });
  if (actor.role !== 'cashier' || !cashierAccessible(bill)) return null;
  const related = sameCustomerBills(bill, snapshot.bills);
  const candidates = related.filter(b => b.uploads?.confirmed_at && cashierAccessible(b) && b.amount_paise !== null && b.invoice_date && b.invoice_reference?.trim() && !isSupportingNote(b) && !isPaid(b, snapshot.payments) && (payerBalance(b, snapshot.payments, payer) || 0) > 0);
  const selected = candidates.filter(b => !excluded.includes(b.id));
  const amountFor = (b: DeskBill) => payerBalance(b, snapshot.payments, payer) || 0;
  const total = selected.reduce((sum, b) => sum + amountFor(b), 0);
  const paidNow = amount === '' ? total : (() => { try { return rupees(amount); } catch { return NaN; } })();
  const referenceLabel = paymentReferenceLabel(method);
  const paysInFull = selected.length > 0 && paidNow === total && selected.every(b => amountFor(b) === balance(b, snapshot.payments));
  async function submit() {
    setError('');
    try {
      if (!selected.length || !Number.isSafeInteger(paidNow) || paidNow <= 0 || paidNow > total) throw new Error('Enter an amount within the selected balance');
      let remaining = paidNow;
      const entries = selected.map(b => { const amountPaise = Math.min(remaining, amountFor(b)); remaining -= amountPaise; return { billId: b.id, amountPaise }; }).filter(e => e.amountPaise > 0);
      const body = { action: 'collect_batch', entries, payer, details: {}, method, otherMethod, transactionId: reference };
      const fingerprint = JSON.stringify(body);
      if (request.current.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      if (await onSubmit({ ...body, requestId: request.current.id })) { request.current = { fingerprint: '', id: '' }; setAmount(''); setExcluded([]); setMethod(''); setOtherMethod(''); setReference(''); }
    } catch (e) { setError((e as Error).message); }
  }
  return <section className="sd-settlement sd-no-print"><form onSubmit={e => { e.preventDefault(); void submit(); }}><h3>{payer === 'customer' ? 'Customer collection' : 'Insurer collection'}</h3><p>{bill.customer_name} · Select invoices to collect together.</p>
    {related.some(b => b.settlement?.kind === "insurance" && cashierAccessible(b)) && <label>Payer<select value={payer} disabled={busy} onChange={e => { setPayer(e.target.value as typeof payer); setAmount(''); setExcluded([]); }}><option value="customer">Customer</option><option value="insurer">Insurer</option></select></label>}
    <div className="sd-actions"><strong>{selected.length} bills selected · {money(total)}</strong><button type="button" disabled={busy || !candidates.length} onClick={() => { setExcluded(selected.length === candidates.length ? candidates.map(b => b.id) : []); setAmount(''); }}>{selected.length === candidates.length ? 'Clear selection' : 'Select all outstanding bills'}</button></div>
    <section className="sd-allocations sd-collection-bills" aria-label="Customer bill selection">{related.map(b => <div className="sd-approval-invoice" key={b.id}><label><input aria-label={`Select bill ${b.invoice_reference}`} type="checkbox" disabled={busy || !candidates.includes(b)} checked={candidates.includes(b) && !excluded.includes(b.id)} onChange={e => { setExcluded(v => e.target.checked ? v.filter(id => id !== b.id) : [...v, b.id]); setAmount(''); }}/>{b.invoice_reference}<small>{b.vehicle_no_display} · {b.invoice_date} · {candidates.includes(b) ? 'Outstanding' : !cashierAccessible(b) ? 'Awaiting TL approval' : 'Not eligible for collection'}</small></label><strong>{candidates.includes(b) ? money(amountFor(b)) : billAmount(b)}</strong><button type="button" onClick={() => onOpenBill(b.id)}>Open bill</button></div>)}</section>
    <div className="sd-settlement-fields"><label>Amount received now (₹)<input type="number" min="0.01" max={total / 100} step="0.01" value={amount === '' ? String(total / 100) : amount} disabled={busy} onChange={e => setAmount(e.target.value)}/></label><label>Mode of payment<select required disabled={busy} value={method} onChange={e => { setMethod(e.target.value); setReference(''); }}><option value="">Select payment method</option>{paymentMethods.map(m => <option key={m}>{m}</option>)}</select></label>
    {method === 'Other' && <label>Specify other payment method<input required maxLength={100} value={otherMethod} disabled={busy} onChange={e => setOtherMethod(e.target.value)}/></label>}
    {referenceLabel && <label>{referenceLabel} (required)<input required maxLength={100} disabled={busy} value={reference} onChange={e => setReference(e.target.value)}/></label>}</div>
    <p>Receipts update the outstanding balance. Approved release limits remain unchanged.</p>{error && <p role="alert" className="sd-warning">{error}</p>}<button className="sd-primary" disabled={busy || !selected.length || !Number.isFinite(paidNow) || paidNow <= 0 || paidNow > total || !method || Boolean(referenceLabel && !reference.trim()) || (method === "Other" && !otherMethod.trim())}>{paysInFull ? 'Mark selected bills as paid' : 'Record payment'} · {money(Number.isFinite(paidNow) ? paidNow : 0)}</button>
  </form></section>;
}
