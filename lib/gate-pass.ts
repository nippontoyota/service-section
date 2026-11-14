export const gateCodePattern = /^[A-Za-z0-9_-]{43}$/;
export type GatePass = {
 status: "Valid" | "Expired" | "Already used" | "Revoked" | "Payment not cleared" | "Invalid";
 id?: string; customerName?: string; vehicle?: string; issuer?: string; expiresAt?: string; exitAt?: string; confirmed?: boolean;
};
export const gatePrivateHeaders = {
 "Cache-Control": "private, no-store, max-age=0",
 "X-Robots-Tag": "noindex, nofollow, noarchive",
 "Referrer-Policy": "no-referrer",
 "X-Content-Type-Options": "nosniff",
};
export function gateCodeFromLink(value: string, origin: string) {
 try {
  const url = new URL(value);
  const code = url.pathname.slice(3);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith("/g/") || !gateCodePattern.test(code)) return null;
  return code;
 } catch { return null; }
}
export function gateMessage(pass: GatePass, link: string) {
 return `Hello ${pass.customerName}, your BillDesk gate pass for vehicle ${pass.vehicle} is ready.\n\n${link}\n\nShow the QR code to security before leaving. This pass allows one exit and expires at ${new Date(pass.expiresAt!).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST. Security will verify your vehicle and confirm exit.`;
}
