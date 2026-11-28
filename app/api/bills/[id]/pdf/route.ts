import { requireStaff, AuthenticationError } from '@/lib/supabase-server';
import { customerPdf } from '@/lib/pdf/customer-copy';
import type { DeskBill } from '@/lib/desk';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
 try {
  const { id } = await context.params;
  const { service, profile } = await requireStaff(request);
  const { data: snapshot, error } = await service.rpc('app_desk_snapshot', { staff: profile.id });
  const bill: DeskBill | undefined = snapshot?.bills?.find((b: DeskBill) => b.id === id);
  if (error || !bill) return new Response('Bill not accessible', { status: 403, headers });
  const { data: upload } = await service.from('uploads').select('storage_path').eq('id', bill.upload_id).single();
  if (!upload) throw new Error('Upload unavailable');
  const { data: file, error: downloadError } = await service.storage.from('bills').download(upload.storage_path);
  if (downloadError || !file) throw new Error('PDF unavailable');
  return new Response(Buffer.from(await customerPdf(new Uint8Array(await file.arrayBuffer()), bill.page_from, bill.page_to)), { headers: { ...headers, 'Content-Type': 'application/pdf' } });
 } catch (error) { return new Response('PDF unavailable', { status: error instanceof AuthenticationError ? 401 : 503, headers }); }
}
