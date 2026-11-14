import { createHash, randomBytes } from "node:crypto";

// 16 random bytes encoded without padding: 128 bits, 22 URL-safe characters.
export const customerBillCode = /^[A-Za-z0-9_-]{21}[AQgw]$/;
export const hashBillCode = (code: string) => createHash("sha256").update(code).digest("hex");

export function customerBillOrigin() {
  try {
    const url = new URL(process.env.BILLDESK_PUBLIC_URL || "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Customer bill links are not configured. Please retry or contact the administrator.");
  }
}

export function newCustomerBillLink(origin: string) {
  const code = randomBytes(16).toString("base64url");
  return { link: `${origin}/b/${code}`, codeHash: hashBillCode(code) };
}
