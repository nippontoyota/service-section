export type PdfLink = { url: string; uploadId: string; expiresAt: number; timings?: { authorization: number; signing: number } };
export class PdfLinks {
  private links = new Map<string, PdfLink>();
  private pending = new Map<string, Promise<PdfLink>>();
  get(uploadId: string, fetchLink: () => Promise<PdfLink>): Promise<PdfLink> {
    const cached = this.links.get(uploadId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return Promise.resolve(cached);
    const pending = this.pending.get(uploadId);
    if (pending) return pending;
    const request = fetchLink().then(link => {
      if (this.pending.get(uploadId) === request) this.links.set(uploadId, link);
      return link;
    }).finally(() => { if (this.pending.get(uploadId) === request) this.pending.delete(uploadId); });
    this.pending.set(uploadId, request);
    return request;
  }
  delete(uploadId: string) { this.links.delete(uploadId); this.pending.delete(uploadId); }
  clear() { this.links.clear(); this.pending.clear(); }
}
