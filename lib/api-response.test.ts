import assert from "node:assert/strict";
import test from "node:test";
import { readApiResponse } from "./api-response";

test("HTML deployment errors become actionable messages instead of JSON parser errors", async () => {
  for (const status of [404, 502, 504]) {
    await assert.rejects(readApiResponse(new Response("<!DOCTYPE html><html>Internal details</html>", { status, headers: { "Content-Type": "text/html" } })), error => {
      assert(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /DOCTYPE|Unexpected token|Internal details/);
      return true;
    });
  }
});

test("valid payloads and server validation messages are preserved", async () => {
  const payload = { whatsappUrl: "https://wa.me/919876543210?text=bill", expiresAt: "2026-11-21T00:00:00Z" };
  assert.deepEqual(await readApiResponse(Response.json(payload)), payload);
  await assert.rejects(readApiResponse(Response.json({ error: "Enter a valid customer WhatsApp number with country code" }, { status: 400 })), /valid customer WhatsApp number/);
  await assert.rejects(readApiResponse(Response.json({ error: "Staff login required" }, { status: 401 })), /Staff login required/);
});

test("empty, malformed and non-object successful responses are rejected clearly", async () => {
  for (const body of ["", "<!DOCTYPE html>", "{broken", "null", "[]", '"hello"']) {
    await assert.rejects(readApiResponse(new Response(body)), /BillDesk returned an unexpected response/);
  }
});
