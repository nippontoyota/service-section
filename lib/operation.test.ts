import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedRequest, RequestTimeoutError } from "./operation";

test("foreground deadlines abort once without retrying or claiming a failed write", async () => {
  let calls = 0;
  let aborted = false;
  await assert.rejects(boundedRequest(signal => {
    calls++;
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => {});
  }, true, 10), error => error instanceof RequestTimeoutError && error.write && /uncertain.*Refresh status/.test(error.message));
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  await assert.rejects(boundedRequest(() => new Promise(() => {}), false, 10), error => error instanceof RequestTimeoutError && !error.write);
  assert.equal(await boundedRequest(async () => "confirmed", true, 50), "confirmed");
  await assert.rejects(boundedRequest(async () => { throw new Error("Denied"); }, true, 50), /Denied/);
});
