import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { extractBills, extractedBillFields } from "@/lib/pdf/extract";
import { requireRole } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let service: Awaited<ReturnType<typeof requireRole>>["service"] | undefined;
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

    const { data: claimed, error: claimError } = await service.from("uploads")
      .update({ status: "processing", processing_error: null }).eq("id", id)
      .in("status", ["uploading", "failed"]).is("confirmed_at", null).select("id").maybeSingle();
    if (claimError || !claimed) return NextResponse.json({ error: "Upload is already processed or processing." }, { status: 409 });
    const { data: blob, error: downloadError } = await service.storage.from("bills").download(upload.storage_path);
    if (downloadError) throw downloadError;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("PDF exceeds the 10 MB limit");
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("The uploaded file is not a valid PDF");

    const extraction = await Promise.race([
      extractBills(bytes),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PDF reading timed out")), 30_000)),
    ]);
    const fileHash = createHash("sha256").update(bytes).digest("hex");

    const { data: sameFiles } = await service
      .from("uploads")
      .select("id, original_filename, created_at")
      .eq("file_hash", fileHash)
      .not("confirmed_at", "is", null)
      .neq("id", id)
      .limit(3);

    const references = extraction.bills
      .flatMap((bill) => [bill.invoiceReference, bill.jobCardReference])
      .filter(Boolean);
    let sameReferences: Array<Record<string, unknown>> = [];
    if (references.length) {
      const [invoiceMatches, jobCardMatches] = await Promise.all([
        service.from("bills").select("id, invoice_reference, job_card_reference, created_at").neq("upload_id", id).in("invoice_reference", references).limit(5),
        service.from("bills").select("id, invoice_reference, job_card_reference, created_at").neq("upload_id", id).in("job_card_reference", references).limit(5),
      ]);
      sameReferences = [...(invoiceMatches.data ?? []), ...(jobCardMatches.data ?? [])]
        .filter((match, index, all) => all.findIndex((candidate) => candidate.id === match.id) === index)
        .slice(0, 5);
    }

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
    if (sameFiles?.length) throw new Error("This PDF has already been submitted. Use the existing bill.");

    await service.from("bills").delete().eq("upload_id", id);
    const { data: savedBills, error: billsError } = await service.from("bills").insert(rows).select();
    if (billsError) throw billsError;
    await service.from("uploads").update({
      status: "review",
      file_hash: fileHash,
      page_count: extraction.pageCount,
    }).eq("id", id);

    return NextResponse.json({
      uploadId: id,
      hasReadableText: extraction.hasReadableText,
      bills: savedBills,
      duplicateWarning: sameFiles?.length || sameReferences.length
        ? { exactFiles: sameFiles ?? [], matchingReferences: sameReferences }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not process PDF";
    if (service) await service.from("uploads").update({ status: "failed", processing_error: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
