import { requireStaff } from "./supabase-server";
import type { Snapshot } from "./desk";

export async function loadDesk(request: Request) {
  const { profile, service } = await requireStaff(request, true);
  if (profile.role === "security" || profile.must_change_password) return { profile };
  const { data, error } = await service.rpc("app_desk_snapshot", { staff: profile.id });
  if (error) throw new Error("Could not refresh workspace. Please retry.");
  const snapshot = data as Snapshot;
  if (profile.role === "service_advisor") {
    const { data: drafts, error: draftError } = await service.from("uploads")
      .select("id,original_filename,status,processing_error,bills(*)")
      .eq("uploaded_by", profile.id).is("confirmed_at", null).order("created_at");
    if (draftError) throw new Error("Could not restore drafts. Please retry.");
    snapshot.drafts = drafts;
  }
  return { profile, snapshot };
}
