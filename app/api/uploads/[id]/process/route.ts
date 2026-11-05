import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let service: Awaited<ReturnType<typeof requireRole>>["service"] | undefined;
  let ownsClaim = false;
  try {
    const auth = await requireRole(request, "service_advisor");
    service = auth.service;
    const { data: upload, error: uploadError } = await service
      .from("uploads")
      .select("*")
      .eq("id", id)
      .eq("uploaded_by", auth.user.id)
      .single();
    if (uploadError || !upload) return NextResponse.json({ error: "Upload not found." }, { status: 404 });

    if (upload.status === "review" && !upload.confirmed_at) {
      const { data: bills, error } = await service.from("bills").select("*,uploads(original_filename,confirmed_at,file_hash)").eq("upload_id", id).order("page_from");
      if (error) throw error;
      return NextResponse.json({ uploadId: id, bills });
    }
    // The function has a 60-second limit. Recover an abandoned claim only after
    // twice that window, and compare its timestamp so an active claim cannot be stolen.
    if (upload.status === "processing" && Date.parse(upload.updated_at) < Date.now() - 120_000) {
      const { error } = await service.from("uploads").update({ status: "failed" }).eq("id", id)
        .eq("status", "processing").eq("updated_at", upload.updated_at).is("confirmed_at", null);
      if (error) throw error;
    }
    const { data: claimed, error: claimError } = await service.from("uploads")
      .update({ status: "processing", processing_error: null }).eq("id", id)
      .in("status", ["uploading", "failed"]).is("confirmed_at", null).select("id").maybeSingle();
    if (claimError || !claimed) return NextResponse.json({ error: "Upload is already processed or processing." }, { status: 409 });
    ownsClaim = true;
    const { data: blob, error: downloadError } = await service.storage.from("bills").download(upload.storage_path);
    if (downloadError) throw downloadError;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("PDF exceeds the 10 MB limit");
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("The uploaded file is not a valid PDF");

    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const duplicateCheck = service
      .from("uploads")
      .select("id, original_filename, created_at")
      .eq("file_hash", fileHash)
      .not("confirmed_at", "is", null)
      .neq("id", id)
      .limit(3);
    const { extractBills, extractedBillFields } = await import("@/lib/pdf/extract");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const [extraction, duplicates] = await Promise.all([
      Promise.race([
        extractBills(bytes),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("PDF reading timed out")), 30_000); }),
      ]),
      duplicateCheck,
    ]).finally(() => clearTimeout(timeout));
    if (duplicates.error) throw duplicates.error;
    if (duplicates.data?.length) throw new Error("This PDF has already been submitted. Use the existing bill.");

    const rows = extraction.bills.map((bill) => ({
      ...extractedBillFields(bill),
      upload_id: id,
      page_from: bill.pageFrom,
      page_to: bill.pageTo,
      connection_key: "pending",
      connection_key_type: "unmatched",
      status: bill.vin && bill.vehicleNo && bill.customerName ? "ready" : "needs_review",
      uploaded_by: auth.user.id,
    }));
    const { error: clearError } = await service.from("bills").delete().eq("upload_id", id);
    if (clearError) throw clearError;
    const { data: savedBills, error: billsError } = await service.from("bills").insert(rows).select();
    if (billsError) throw billsError;
    const { error: updateError } = await service.from("uploads").update({
      status: "review",
      file_hash: fileHash,
      page_count: extraction.pageCount,
    }).eq("id", id);
    if (updateError) throw updateError;

    return NextResponse.json({
      uploadId: id,
      hasReadableText: extraction.hasReadableText,
      bills: savedBills.map(bill => ({ ...bill, uploads: { original_filename: upload.original_filename, confirmed_at: null, file_hash: fileHash } })),
      duplicateWarning: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not process PDF";
    if (service && ownsClaim) await service.from("uploads").update({ status: "failed", processing_error: message }).eq("id", id).eq("status", "processing").is("confirmed_at", null);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
