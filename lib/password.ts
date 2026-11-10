import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP scrypt configuration: N=2^15, r=8, p=3. Every password has its own salt.
const prefix = "scrypt$32768$8$3";
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error); else resolve(key);
  });
});

export async function hashPassword(password: string, maxLength = 128) {
  if (typeof password !== "string" || password.length < 6 || password.length > maxLength) throw new Error(`Use a password between 6 and ${maxLength} characters`);
  const salt = randomBytes(16).toString("hex");
  return `${prefix}$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  if (!/^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded) || password.length > 128) return false;
  const parts = encoded.split("$");
  return timingSafeEqual(await derive(password, parts[4]), Buffer.from(parts[5], "hex"));
}

// Unknown accounts still perform the same expensive comparison.
export const dummyPasswordHash = `${prefix}$${"0".repeat(32)}$${"0".repeat(128)}`;
export const hashSessionToken = (token: string) => createHash("sha256").update(token).digest("hex");
