import { requireStaff, AuthenticationError } from '@/lib/supabase-server';
import { approvedPdf } from '@/lib/pdf/approved-copy';
import type { DeskBill } from '@/lib/desk';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { service, profile } = await requireStaff(request);
    if (!['cashier', 'team_leader', 'service_advisor', 'super_admin'].includes(profile.role)) return new Response('Bill not accessible', { status: 403, headers });
    // Revoked documents remain available to their advisor, TL and admin, with an explicit revoked stamp.
    const { data: record, error } = await service.from('bills').select('*,settlement:settlement_cases(*),uploads!inner(storage_path,confirmed_at)').eq('id', id).single();
    if (error || !record || (profile.role === 'service_advisor' && record.uploaded_by !== profile.id)) return new Response('Bill not accessible', { status: 404, headers });
    const bill = record as DeskBill;
    const s = bill.settlement;
    if (!record.uploads.confirmed_at || s?.kind !== 'insurance' || !s.approved_name || !s.approved_at || !['approved', 'revoked'].includes(s.state || '')) return new Response('A recorded TL approval is required', { status: 409, headers });
    const { data: file, error: downloadError } = await service.storage.from('bills').download(record.uploads.storage_path);
    if (downloadError || !file) throw new Error('Original invoice could not be loaded');
    const bytes = await approvedPdf(new Uint8Array(await file.arrayBuffer()), bill.page_from, bill.page_to, { name: s.approved_name, at: s.approved_at, number: s.number, revoked: s.revoked });
    return new Response(Buffer.from(bytes), { headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="verified-invoice-${s.number}.pdf"` } });
  } catch (error) {
    return new Response(error instanceof AuthenticationError ? 'Sign in to view this bill' : 'The approved PDF could not be generated. Please retry or contact the administrator.', { status: error instanceof AuthenticationError ? 401 : 503, headers });
  }
}
