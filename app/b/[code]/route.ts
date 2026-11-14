import { createServiceClient } from "@/lib/supabase-server";
import { customerBillCode, hashBillCode } from "@/lib/customer-bill-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  const head = request.method === "HEAD";
  const fail = (message: string, status: number) => new Response(head ? null : message, {
    status, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" },
  });
  const { code } = await context.params;
  if (!customerBillCode.test(code)) return fail("This bill link is invalid.", 404);
  try {
    const service = createServiceClient();
    const { data: link, error } = await service.from("customer_bill_links")
      .select("storage_path,expires_at").eq("code_hash", hashBillCode(code)).maybeSingle();
    if (error) throw new Error("Lookup failed");
    if (!link) return fail("This bill link is invalid.", 404);
    if (!(Date.parse(link.expires_at) > Date.now())) return fail("This bill link has expired. Please request a new link from your advisor.", 410);

    // Fetch directly to preserve streaming and HEAD semantics; never forward storage headers.
    const path = link.storage_path.split("/").map(encodeURIComponent).join("/");
    const upstream = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/bills/${path}`, {
      method: head ? "HEAD" : "GET",
      headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY! },
      cache: "no-store", redirect: "error", signal: request.signal,
    });
    if (!upstream.ok || (!head && !upstream.body)) {
      await upstream.body?.cancel();
      throw new Error("Download failed");
    }
    return new Response(head ? null : upstream.body, {
      headers: { ...privateHeaders, "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="bill.pdf"' },
    });
  } catch {
    return fail("Your bill is temporarily unavailable. Please retry shortly.", 503);
  }
}

export const HEAD = GET;
