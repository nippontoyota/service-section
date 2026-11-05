import type { DeskBill, Snapshot } from "./desk";
export type UploadFile = {
  id: string; identity?: string; name: string; file?: File; localUrl?: string;
  uploadId?: string; signedUrl?: string; stored?: boolean; progress: number;
  bills: DeskBill[]; state: "selected" | "uploading" | "reading" | "ready" | "failed" | "submitting";
  error?: string;
};
export const fileIdentity = (file: Pick<File, "name" | "size" | "lastModified">) => JSON.stringify([file.name, file.size, file.lastModified]);
export function selectFiles(queue: UploadFile[], incoming: File[]) {
  const added: File[] = [], errors: string[] = [];
  const identities = new Set(queue.map(item => item.identity));
  for (const file of incoming) {
    const identity = fileIdentity(file);
    if (identities.has(identity)) continue;
    if (!file.name.toLowerCase().endsWith(".pdf") || !file.size || file.size > 10 * 1024 * 1024) { errors.push(`${file.name}: choose a nonempty PDF up to 10 MB.`); continue; }
    if (queue.length + added.length >= 10) { errors.push("A batch can contain up to 10 PDFs."); break; }
    identities.add(identity); added.push(file);
  }
  return { added, errors };
}
export function restoreDrafts(snapshot: Snapshot): UploadFile[] {
  const drafts = snapshot.drafts ?? [...new Set(snapshot.bills.filter(b => !b.uploads?.confirmed_at).map(b => b.upload_id))].map(id => ({ id, original_filename: snapshot.bills.find(b => b.upload_id === id)?.uploads?.original_filename || "PDF", status: "review", processing_error: null, bills: snapshot.bills.filter(b => b.upload_id === id) }));
  return drafts.map(d => ({ id: d.id, uploadId: d.id, name: d.original_filename, stored: d.status !== "uploading", progress: d.status === "review" ? 100 : 0,
    state: d.status === "review" && d.bills.length ? "ready" : "failed",
    error: d.status === "review" ? undefined : d.processing_error || (d.status === "uploading" ? "Reselect the original PDF to finish uploading." : "Processing was interrupted. Retry to check this upload."),
    bills: d.status === "review" ? [...d.bills].sort((a,b) => a.page_from - b.page_from).map(b => ({ ...b, uploads: { ...b.uploads, original_filename: d.original_filename, confirmed_at: null } })) : [],
  }));
}
export async function withTwoWorkers<T>(items: T[], task: (item: T) => Promise<void>) {
  let next = 0;
  async function worker() { while (next < items.length) await task(items[next++]); }
  await Promise.all([worker(), worker()]);
}
