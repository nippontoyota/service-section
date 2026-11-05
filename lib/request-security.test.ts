import test from "node:test";
import assert from "node:assert/strict";
import { requireSameOrigin } from "./request-security";

test("browser-facing host is accepted when Next binds to a different address", () => {
  for (const origin of ["http://localhost:3000", "https://billdesk.example"]) {
    const request = new Request("http://0.0.0.0:3000/api/auth/login", { method: "POST", headers: {
      host: new URL(origin).host, origin, "content-type": "application/json; charset=UTF-8", "sec-fetch-site": "same-origin",
    } });
    assert.doesNotThrow(() => requireSameOrigin(request));
  }
});

test("cross-origin, cross-site and non-JSON posts remain rejected", () => {
  for (const changes of [
    { origin: "https://attacker.example" },
    { origin: "http://localhost:3001" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" },
    { "content-type": "application/json-invalid" },
  ]) {
    const request = new Request("http://0.0.0.0:3000/api/desk", { method: "POST", headers: {
      host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json", ...changes,
    } as Record<string, string> });
    assert.throws(() => requireSameOrigin(request));
  }
});
