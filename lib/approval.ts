import { balance, collected, customerKey, indiaDate, isSupportingNote, type DeskBill, type Snapshot, type Staff } from './desk';
import { payerCollected, vehicleKey, type Settlement, type SettlementDetails } from './settlement';

export const approvalActions = ['save_request', 'submit_request', 'approve_request', 'return_request', 'acknowledge_request', 'add_followup', 'set_bill_route'] as const;
export type ApprovalState = 'draft' | 'pending' | 'returned' | 'approved' | 'legacy_approved' | 'revoked';
export type ApprovalEntry = { billId: string; insurerPaise?: number; creditPaise?: number };
export type Followup = { id: string; actorName: string; createdAt: string; contact: string; note: string; promisedDate: string; nextDate: string };
export type ApprovalRequest = {
  action: typeof approvalActions[number]; requestId: string; settlementId?: string; revision?: number;
  kind?: 'insurance' | 'credit'; entries: ApprovalEntry[]; details: SettlementDetails;
  target?: string; reason: string; followup: Pick<Followup, 'contact' | 'note' | 'promisedDate' | 'nextDate'>;
};
export const approvalState = (s: Settlement) => s.revoked ? 'revoked' : s.state || 'legacy_approved';
export const arrangementApproved = (s?: Settlement | null) => !s || ['approved', 'legacy_approved'].includes(approvalState(s));
export const cashierAccessible = (b: DeskBill) => arrangementApproved(b.settlement);
export function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function normalizeApprovalRequest(body: Record<string, unknown>): ApprovalRequest {
  if (!approvalActions.includes(body.action as ApprovalRequest['action'])) throw new Error('Unknown approval action');
  if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.requestId)) throw new Error('Request reference required');
  const text = (value: unknown, max = 1000) => { if (value == null) return ''; if (typeof value !== 'string' || value.length > max) throw new Error('Invalid form details'); return value.trim(); };
  const details: SettlementDetails = {};
  for (const key of ['insurer', 'contactPerson', 'contactNumber', 'responsibleStaff', 'responsibleStaffId', 'dueDate', 'remarks'] as const) details[key] = text((body.details as SettlementDetails | undefined)?.[key]);
  const entries = body.entries ?? [];
  if (!Array.isArray(entries) || entries.length > 100) throw new Error('Select up to 100 bills');
  const normalized = entries.map((e: ApprovalEntry) => {
    if (!e || typeof e.billId !== 'string') throw new Error('Invalid bill');
    for (const value of [e.insurerPaise, e.creditPaise]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 100000000000)) throw new Error('Invalid requested amount');
    return { billId: e.billId, insurerPaise: e.insurerPaise, creditPaise: e.creditPaise };
  });
  if (new Set(normalized.map(e => e.billId)).size !== normalized.length) throw new Error('Duplicate bill');
  if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1)) throw new Error('Invalid revision');
  const f = body.followup as Partial<Followup> | undefined;
  const followup = { contact: text(f?.contact, 200), note: text(f?.note), promisedDate: text(f?.promisedDate, 10), nextDate: text(f?.nextDate, 10) };
  for (const date of [details.dueDate, followup.promisedDate, followup.nextDate]) if (date && !validDate(date)) throw new Error('Invalid date');
  if (['save_request', 'approve_request'].includes(String(body.action)) && (!['insurance', 'credit'].includes(String(body.kind)) || !normalized.length)) throw new Error('Select insurance or credit and at least one bill');
  if (body.action === 'return_request' && !text(body.reason)) throw new Error('Return reason required');
  if (body.action === 'add_followup' && (!followup.contact || !followup.note)) throw new Error('Contact and follow-up note required');
  return { action: body.action as ApprovalRequest['action'], requestId: body.requestId, settlementId: typeof body.settlementId === 'string' ? body.settlementId : undefined,
    revision: body.revision as number | undefined, kind: body.kind as ApprovalRequest['kind'], entries: normalized, details,
    target: typeof body.target === 'string' ? body.target : undefined, reason: text(body.reason), followup };
}
export function validateApproval(s: Settlement, bills: DeskBill[], payments: Snapshot['payments']) {
  if (!s.details.contactPerson || !s.details.contactNumber || !s.details.responsibleStaffId || !s.details.dueDate || !validDate(s.details.dueDate) || s.details.dueDate < indiaDate()) throw new Error('Contact, responsible staff and a current or future due date are required');
  if (!/^\+?[0-9 ()-]{7,40}$/.test(s.details.contactNumber)) throw new Error('Enter a valid contact number');
  if (s.kind === 'credit' && !s.details.remarks?.trim()) throw new Error('Credit reason required');
  if (s.kind === 'insurance' && !s.details.insurer) throw new Error('Insurer name required');
  if (!bills.length || s.proposal?.length !== bills.length) throw new Error('Select bills for this request');
  for (const b of bills) {
    if (b.amount_paise === null || !b.invoice_date || !b.invoice_reference || isSupportingNote(b)) throw new Error('Readable invoice total, number and date required');
    const e = s.proposal.find(e => e.billId === b.id);
    const amount = s.kind === 'insurance' ? e?.insurerPaise : e?.creditPaise;
    if (!Number.isSafeInteger(amount) || amount! < 0 || amount! > b.amount_paise) throw new Error('Requested amount must fit invoice total');
    if (s.kind === 'insurance' && (amount! < payerCollected(b, payments, 'insurer') || b.amount_paise - amount! < payerCollected(b, payments, 'customer'))) throw new Error('Split must cover existing receipts');
    if (s.kind === 'credit' && (amount! > balance(b, payments)! || payerCollected(b, payments, 'insurer') > 0)) throw new Error('Credit must fit outstanding customer balance');
  }
}
export function demoApproval(snapshot: Snapshot, actor: Staff, r: ApprovalRequest): Snapshot {
  if (!actor.active || actor.must_change_password) throw new Error('Active staff required');
  const previous = snapshot.audit.find(a => a.detail.requestId === r.requestId);
  if (previous) { if (previous.actor_id !== actor.id || JSON.stringify(previous.detail.request) !== JSON.stringify(r)) throw new Error('Request reference already used'); return snapshot; }
  const next = structuredClone(snapshot), now = new Date().toISOString();
  let bills = next.bills.filter(b => r.settlementId && b.settlement?.id === r.settlementId);
  let s = bills[0]?.settlement;
  if (r.action === 'set_bill_route') {
    const b = next.bills.find(b => b.id === r.target);
    if (actor.role !== 'service_advisor' || !b || b.uploaded_by !== actor.id || b.uploads?.confirmed_at || b.settlement) throw new Error('Only your unsubmitted ordinary bill can be classified');
    b.payment_route = 'ordinary'; bills = [b];
  } else {
    if (s && s.revision !== r.revision) throw new Error('Request changed. Refresh before continuing.');
    if (!s && r.action !== 'save_request') throw new Error('Request not found');
    if (r.action === 'save_request') {
      if (actor.role !== 'service_advisor' || (s && (s.recorded_by !== actor.id || !['draft', 'returned'].includes(approvalState(s))))) throw new Error('Advisor draft required');
      const chosen = r.entries.map(e => next.bills.find(b => b.id === e.billId));
      if (chosen.some(b => !b || b.uploaded_by !== actor.id || isSupportingNote(b) || b.gate_completed || (b.settlement && b.settlement.id !== s?.id && !b.settlement.revoked))) throw new Error('Select your available invoices');
      const first = chosen[0]!;
      if (chosen.some(b => customerKey(b!) !== customerKey(first) || (b!.id !== first.id && (!vehicleKey(first.vehicle_no_display) || vehicleKey(b!.vehicle_no_display) !== vehicleKey(first.vehicle_no_display))))) throw new Error('Select one customer and vehicle');
      if (s && (chosen.length !== bills.length || chosen.some(b => !bills.includes(b!)))) throw new Error('Request bill selection is locked');
      if (!s && chosen.some(b => collected(b!, next.payments) > 0 && !b!.settlement?.revoked)) throw new Error('Correct existing collections before starting a request');
      bills = chosen as DeskBill[];
      s = { id: r.settlementId || r.requestId, number: s?.number || Math.max(0, ...next.bills.map(b => b.settlement?.number || 0)) + 1, kind: r.kind!, details: r.details, revoked: false,
        created_at: s?.created_at || now, recorded_by: actor.id, advisor_name: actor.full_name, state: 'draft', revision: (s?.revision || 0) + 1, proposal: r.entries, followups: s?.followups || [] };
    } else if (r.action === 'approve_request') {
      if (actor.role !== 'team_leader' || approvalState(s!) !== 'pending') throw new Error('Pending request and Team Leader required');
      if (r.kind !== s!.kind || r.entries.length !== bills.length || r.entries.some(e => !bills.some(b => b.id === e.billId))) throw new Error('Request bill selection is locked');
      s!.details = { ...r.details, responsibleStaff: next.staff.find(p => p.id === r.details.responsibleStaffId)?.full_name }; s!.proposal = r.entries;
      validateApproval(s!, bills, next.payments);
      s!.state = 'approved'; s!.approved_name = actor.full_name; s!.approved_by = actor.id; s!.approved_at = now;
      s!.approved_snapshot = { details: structuredClone(s!.details), entries: structuredClone(r.entries), bills: bills.map(b => ({ id: b.id, customer_name: b.customer_name, invoice_reference: b.invoice_reference, amount_paise: b.amount_paise })) };
      for (const b of bills) { const e = r.entries.find(e => e.billId === b.id)!; b.customer_share_paise = s!.kind === 'insurance' ? b.amount_paise! - e.insurerPaise! : null; b.credit_limit_paise = s!.kind === 'credit' ? e.creditPaise : null; }
    } else if (r.action === 'submit_request') {
      if (actor.role !== 'service_advisor' || s!.recorded_by !== actor.id || !['draft', 'returned'].includes(approvalState(s!)) || bills.some(b => !b.uploads?.confirmed_at)) throw new Error('Submit the advisor uploads first');
      validateApproval(s!, bills, next.payments); s!.state = 'pending'; s!.submitted_snapshot = { details: structuredClone(s!.details), entries: structuredClone(s!.proposal) };
    } else if (r.action === 'return_request') {
      if (actor.role !== 'team_leader' || approvalState(s!) !== 'pending') throw new Error('Pending request and Team Leader required');
      s!.state = 'returned'; s!.return_reason = r.reason;
    } else if (r.action === 'acknowledge_request') {
      if (actor.role !== 'cashier' || !arrangementApproved(s)) throw new Error('TL approval and cashier required');
      s!.acknowledged_at ||= now;
      for (const b of bills) { b.approval_status = 'approved'; b.approved_by ||= actor.id; b.approved_at ||= now; }
    } else if (r.action === 'add_followup') {
      if (actor.role !== 'team_leader' || !['approved', 'legacy_approved'].includes(approvalState(s!))) throw new Error('Approved case and Team Leader required');
      s!.followups = [...(s!.followups || []), { ...r.followup, id: r.requestId, actorName: actor.full_name, createdAt: now }];
    }
    if (s) {
      if (r.action !== 'save_request') s.revision = (s.revision || 0) + 1;
      const responsible = next.staff.find(p => p.id === s!.details.responsibleStaffId && p.role === 'service_advisor' && p.active);
      if (['save_request', 'approve_request'].includes(r.action)) { if (!responsible) throw new Error('Choose an active responsible advisor'); s.details.responsibleStaff = responsible.full_name; }
      for (const b of bills) { b.settlement = structuredClone(s); b.payment_route = s.kind; }
    }
  }
  for (const b of bills) next.audit.unshift({ id: crypto.randomUUID(), bill_id: b.id, actor_id: actor.id, action: r.action, created_at: now, detail: { requestId: r.requestId, request: r } });
  next.as_of = now; return next;
}
