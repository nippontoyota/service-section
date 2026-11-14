import { NextResponse } from "next/server";
import { AuthenticationError, requireRole } from "@/lib/supabase-server";
import { customerPhone, customerLinkSeconds, customerShareBills, shareBillIds, whatsappMessage, whatsappUrl } from "@/lib/whatsapp";
import { customerPdf } from "@/lib/pdf/customer-copy";
import { customerBillOrigin, newCustomerBillLink } from "@/lib/customer-bill-links";
import type { DeskBill } from "@/lib/desk";

type ShareBill = DeskBill & { uploads: { storage_path: string; confirmed_at: string; file_hash: string | null } };

export const runtime = "nodejs";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, profile, service } = await requireRole(request, "service_advisor");
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Bill not accessible" }, 404);
    let phone: string, billIds: string[] | undefined;
    try {
      const body = await request.json();
      phone = customerPhone(body?.customerPhone);
      billIds = shareBillIds(body?.billIds, id);
    } catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid WhatsApp request" }, 400); }
    const { data: bill, error } = await service.from("bills")
      .select("*,uploads!inner(storage_path,confirmed_at,file_hash)").eq("id", id).eq("uploaded_by", user.id).maybeSingle();
    if (error) throw new Error("Could not load the bill. Please retry.");
    if (!bill) return json({ error: "Bill not accessible" }, 404);
    if (!bill.uploads.confirmed_at) return json({ error: "Submit this bill to the cashier before sharing" }, 409);
    let related: ShareBill[] = [bill];
    if (billIds) {
      const { data, error } = await service.from("bills")
        .select("*,uploads!inner(storage_path,confirmed_at,file_hash)")
        .in("id", billIds).eq("uploaded_by", user.id).returns<ShareBill[]>();
      if (error || !data) throw new Error("Could not load the selected bills. Please retry.");
      related = data;
    } else if (bill.customer_id) {
      const { data, error } = await service.from("bills")
        .select("*,uploads!inner(storage_path,confirmed_at,file_hash)")
        .eq("customer_id", bill.customer_id).eq("uploaded_by", user.id).not("uploads.confirmed_at", "is", null).returns<ShareBill[]>();
      if (error || !data) throw new Error("Could not load the customer's bills. Please retry.");
      related = data;
    }
    const bills = customerShareBills(bill, related) as ShareBill[];
    if (billIds && (related.length !== billIds.length || bills.length !== billIds.length || bills.some(current => !billIds.includes(current.id)))) {
      return json({ error: "Every selected bill must be submitted and belong to this customer and your account" }, 409);
    }
    const origin = customerBillOrigin();
    const bucket = service.storage.from("bills");
    const sources = new Map<string, Uint8Array>();
    const links: { bill: ShareBill; link: string }[] = [];
    const mappings: { code_hash: string; bill_id: string; storage_path: string; expires_at: string }[] = [];
    const expiresAt = new Date(Date.now() + customerLinkSeconds * 1000).toISOString();
    for (const current of bills) {
      const path = `customer-copies/v1/${current.upload_id}/${current.uploads.file_hash || "original"}/${current.id}-${current.page_from}-${current.page_to}.pdf`;
      const { data: exists } = await bucket.exists(path);
      if (!exists) {
        let sourceBytes = sources.get(current.upload_id);
        if (!sourceBytes) {
          const { data: source, error: downloadError } = await bucket.download(current.uploads.storage_path);
          if (downloadError || !source) throw new Error("A customer's original PDF could not be loaded. Please retry.");
          sourceBytes = new Uint8Array(await source.arrayBuffer());
          sources.set(current.upload_id, sourceBytes);
        }
        const bytes = await customerPdf(sourceBytes, current.page_from, current.page_to);
        const { error: uploadError } = await bucket.upload(path, bytes, { contentType: "application/pdf", cacheControl: "0", upsert: false });
        if (uploadError && !(await bucket.exists(path)).data) throw new Error("A customer PDF could not be prepared. Please retry.");
      }
      const { link, codeHash } = newCustomerBillLink(origin);
      mappings.push({ code_hash: codeHash, bill_id: current.id, storage_path: path, expires_at: expiresAt });
      links.push({ bill: current, link });
    }
    // One insert saves the whole set atomically. Raw codes are never persisted.
    const { error: linkError } = await service.from("customer_bill_links").insert(mappings);
    if (linkError) throw new Error("All customer bill links could not be saved. Please retry.");
    // Do not return an incomplete message if any bill failed preparation.
    for (const current of bills) {
      const { error: auditError } = await service.rpc("app_prepare_whatsapp", { staff: user.id, target: current.id, phone, expires_at: expiresAt });
      if (auditError) throw new Error(auditError.code === "PGRST202" ? "WhatsApp sharing requires the latest database migration." : "Could not save WhatsApp preparation. Please retry.");
    }
    const message = whatsappMessage(links, profile.full_name);
    return json({ whatsappUrl: whatsappUrl(phone, message), message, billIds: bills.map(bill => bill.id), expiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp preparation failed. Please retry.";
    const status = error instanceof AuthenticationError ? 401 : /role required|Same-origin|Password change required/.test(message) ? 403 : 503;
    return json({ error: message }, status);
  }
}
