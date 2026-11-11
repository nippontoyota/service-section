import { NextResponse } from "next/server";
import { AuthenticationError, requireRole } from "@/lib/supabase-server";
import { customerPhone, customerLinkSeconds, whatsappMessage, whatsappUrl } from "@/lib/whatsapp";
import { customerPdf } from "@/lib/pdf/customer-copy";

export const runtime = "nodejs";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, profile, service } = await requireRole(request, "service_advisor");
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Bill not accessible" }, 404);
    let phone: string;
    try { phone = customerPhone((await request.json())?.customerPhone); }
    catch { return json({ error: "Enter a valid customer WhatsApp number with country code" }, 400); }
    const { data: bill, error } = await service.from("bills")
      .select("*,uploads!inner(storage_path,confirmed_at,file_hash)").eq("id", id).eq("uploaded_by", user.id).maybeSingle();
    if (error) throw new Error("Could not load the bill. Please retry.");
    if (!bill) return json({ error: "Bill not accessible" }, 404);
    if (!bill.uploads.confirmed_at) return json({ error: "Submit this bill to the cashier before sharing" }, 409);
    const bucket = service.storage.from("bills");
    const path = `customer-copies/v1/${bill.upload_id}/${bill.uploads.file_hash || "original"}/${bill.id}-${bill.page_from}-${bill.page_to}.pdf`;
    const { data: exists } = await bucket.exists(path);
    if (!exists) {
      const { data: source, error: downloadError } = await bucket.download(bill.uploads.storage_path);
      if (downloadError || !source) throw new Error("Original PDF could not be loaded. Please retry.");
      const bytes = await customerPdf(new Uint8Array(await source.arrayBuffer()), bill.page_from, bill.page_to);
      const { error: uploadError } = await bucket.upload(path, bytes, { contentType: "application/pdf", cacheControl: "0", upsert: false });
      // Concurrent preparations may create the same immutable copy.
      if (uploadError && !(await bucket.exists(path)).data) throw new Error("Customer PDF could not be prepared. Please retry.");
    }
    const expiresAt = new Date(Date.now() + customerLinkSeconds * 1000).toISOString();
    const { data: signed, error: signError } = await bucket.createSignedUrl(path, customerLinkSeconds);
    if (signError || !signed) throw new Error("Customer link could not be prepared. Please retry.");
    const { error: auditError } = await service.rpc("app_prepare_whatsapp", { staff: user.id, target: id, phone, expires_at: expiresAt });
    if (auditError) throw new Error(auditError.code === "PGRST202" ? "WhatsApp sharing requires the latest database migration." : "Could not save WhatsApp preparation. Please retry.");
    return json({ whatsappUrl: whatsappUrl(phone, whatsappMessage(bill, signed.signedUrl, profile.full_name)), expiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp preparation failed. Please retry.";
    const status = error instanceof AuthenticationError ? 401 : /role required|Same-origin|Password change required/.test(message) ? 403 : 503;
    return json({ error: message }, status);
  }
}
