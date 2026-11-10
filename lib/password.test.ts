import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dummyPasswordHash, hashPassword, hashSessionToken, verifyPassword } from "./password";

test("passwords use independent salts and reject wrong, malformed and oversized values", async () => {
  const password = "TestPassword!2026";
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("WrongPassword!2026", first), false);
  assert.equal(await verifyPassword(password, "sha256$bad"), false);
  assert.equal(await verifyPassword("x".repeat(129), first), false);
  assert.equal(await verifyPassword(password, dummyPasswordHash), false);
  await assert.rejects(hashPassword("short"));
  await assert.rejects(hashPassword("x".repeat(129)));
  for (const invalid of [undefined, null, 123, {}]) {
    await assert.rejects(hashPassword(invalid as string), /between 6 and 128/);
  }
  assert.equal(hashSessionToken("token").length, 64);
  assert.notEqual(hashSessionToken("token"), hashSessionToken("other"));
});

test("admin-created passwords accept any characters at 6–8 characters", async () => {
  for (const password of ["abcdef", "1234567", "!@#$%^&*", " a b c ", "密码密码密码"]) {
    const hash = await hashPassword(password, 8);
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword(password + "x", hash), false);
  }
  for (const invalid of [undefined, null, 123456, {}, "", "abcde", "abcdefghi"]) {
    await assert.rejects(hashPassword(invalid as string, 8), /between 6 and 8/);
  }
});

test("bootstrap hashes match the three requested initial passwords", async () => {
  const script = readFileSync("scripts/bootstrap-staff.mjs", "utf8");
  const hashes = [...script.matchAll(/scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}/g)].map(m => m[0]);
  assert.equal(hashes.length, 3);
  for (const [index, password] of ["AdminDemo!2026", "CashierDemo!2026", "AdvisorDemo!2026"].entries()) {
    assert.equal(await verifyPassword(password, hashes[index]), true);
    assert.equal(script.includes(password), false);
  }
});
