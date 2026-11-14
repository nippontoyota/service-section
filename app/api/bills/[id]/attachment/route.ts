import { AuthenticationError, requireRole } from "@/lib/supabase-server";
import { customerCopyPath } from "@/lib/pdf/customer-copy";
import { billFilename } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const fail = (message: string, status: number) => new Response(message, { status, headers });
  try {
    const { user, service } = await requireRole(request, "service_advisor");
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("Bill not accessible", 404);
    const { data: bill, error } = await service.from("bills")
      .select("*,uploads!inner(storage_path,confirmed_at,file_hash)").eq("id", id).eq("uploaded_by", user.id).maybeSingle();
    if (error) throw new Error("Lookup failed");
    if (!bill) return fail("Bill not accessible", 404);
    if (!bill.uploads.confirmed_at) return fail("Submit this bill before downloading its attachment", 409);
    const path = customerCopyPath(bill).split("/").map(encodeURIComponent).join("/");
    // Stream the private copy without buffering or exposing storage credentials/URLs.
    const upstream = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/bills/${path}`, {
      headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY! },
      cache: "no-store", redirect: "error", signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return fail("PDF unavailable. Prepare the attachments again and retry.", upstream.status === 404 ? 404 : 503);
    }
    return new Response(upstream.body, { headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${billFilename(bill)}"` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (error instanceof AuthenticationError) return fail("Staff login required", 401);
    if (/role required|Password change required/.test(message)) return fail("Bill not accessible", 403);
    return fail("PDF temporarily unavailable. Please retry.", 503);
  }
}
