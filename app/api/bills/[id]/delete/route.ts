import { NextResponse } from "next/server";
import { AuthenticationError, requireRole } from "@/lib/supabase-server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, service } = await requireRole(request, "service_advisor");
    const { id } = await context.params;
    const { data: bill, error } = await service.from("bills").select("id,upload_id,approval_status")
      .eq("id", id).eq("uploaded_by", user.id).maybeSingle();
    if (error) throw error;
    if (!bill) return NextResponse.json({ error: "Bill not found." }, { status: 404 });
    if (bill.approval_status !== "pending") return NextResponse.json({ error: "Only draft bills can be deleted." }, { status: 409 });

    // Claim the upload using the same state checked by process/confirm. This
    // prevents submission or another deletion while this draft is being removed.
    const { data: upload, error: claimError } = await service.from("uploads")
      .update({ status: "processing" }).eq("id", bill.upload_id).eq("uploaded_by", user.id)
      .eq("status", "review").is("confirmed_at", null).select("id,storage_path").maybeSingle();
    if (claimError) throw claimError;
    if (!upload) return NextResponse.json({ error: "Only unsubmitted drafts can be deleted. This upload may be busy; please refresh." }, { status: 409 });
    try {
      const { data: deleted, error: deleteError } = await service.from("bills").delete()
        .eq("id", id).eq("uploaded_by", user.id).eq("approval_status", "pending").select("id");
      if (deleteError) throw deleteError;
      if (!deleted?.length) throw new Error("Bill could not be deleted. Refresh and try again.");
      const { count, error: countError } = await service.from("bills").select("id", { count: "exact", head: true }).eq("upload_id", upload.id);
      if (countError) throw countError;
      let warning: string | undefined;
      if (count === 0) {
        const { error: uploadError } = await service.from("uploads").delete().eq("id", upload.id).eq("status", "processing").is("confirmed_at", null);
        if (uploadError) throw uploadError;
        const { error: storageError } = await service.storage.from("bills").remove([upload.storage_path]);
        if (storageError) {
          console.error("Deleted draft PDF cleanup failed", upload.id, storageError.message);
          warning = "Bill deleted. Its stored PDF could not be removed; contact your administrator for storage cleanup.";
        }
      }
      return NextResponse.json({ deletedId: id, warning }, { headers: { "Cache-Control": "no-store" } });
    } finally {
      const { error: releaseError } = await service.from("uploads").update({ status: "review" })
        .eq("id", upload.id).eq("status", "processing").is("confirmed_at", null);
      if (releaseError) console.error("Draft deletion lock release failed", upload.id, releaseError.message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete draft. Refresh and try again.";
    return NextResponse.json({ error: message }, { status: error instanceof AuthenticationError ? 401 : message.includes("required") ? 403 : 500 });
  }
}
