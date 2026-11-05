import { NextResponse } from "next/server";
import { AuthenticationError, requireRole } from "@/lib/supabase-server";

export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, service } = await requireRole(request, "service_advisor");
    const { id } = await context.params;
    const { data: draft, error } = await service.from("uploads").select("status,storage_path,bills(approval_status)")
      .eq("id", id).eq("uploaded_by", user.id).is("confirmed_at", null).maybeSingle();
    if (error) throw error;
    if (!draft || !["uploading", "failed", "review"].includes(draft.status) || draft.bills.some(bill => bill.approval_status !== "pending")) return NextResponse.json({ error: "Only idle, unsubmitted drafts can be deleted." }, { status: 409 });
    const { data: claimed, error: claimError } = await service.from("uploads").update({ status: "processing" })
      .eq("id", id).eq("uploaded_by", user.id).eq("status", draft.status).is("confirmed_at", null).select("id").maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return NextResponse.json({ error: "This draft is busy. Refresh and retry." }, { status: 409 });
    try {
      const { error: deleteError } = await service.from("uploads").delete().eq("id", id).eq("status", "processing").is("confirmed_at", null);
      if (deleteError) throw deleteError;
      const { error: storageError } = await service.storage.from("bills").remove([draft.storage_path]);
      if (storageError) console.error("Draft PDF cleanup failed", id, storageError.message);
      return NextResponse.json({ deletedId: id, warning: storageError ? "Draft deleted; stored PDF cleanup needs administrator attention." : undefined });
    } finally {
      await service.from("uploads").update({ status: draft.status }).eq("id", id).eq("status", "processing").is("confirmed_at", null);
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not delete draft" }, { status: error instanceof AuthenticationError ? 401 : 400 });
  }
}
