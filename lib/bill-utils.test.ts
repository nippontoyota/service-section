import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCounts, filterBills, groupBills, normalizeIdentifier } from "./bill-utils";
import type { Bill } from "./types";

const bills: Bill[] = [
  {
    id: "1",
    uploadId: "u1",
    connectionKey: "VIN:MA3FJEB1S00A12345",
    connectionKeyType: "vin",
    customerName: "Asha Nair",
    vehicleNo: "KL 07 AB 1234",
    vin: "MA3FJEB1S00A12345",
    advisorName: "Amal",
    createdAt: "2026-10-23T09:00:00+05:30",
    status: "ready",
    pageFrom: 1,
    pageTo: 1,
    fileName: "asha.pdf",
  },
  {
    id: "2",
    uploadId: "u2",
    connectionKey: "VIN:MA3FJEB1S00A12345",
    connectionKeyType: "vin",
    customerName: "Asha Nair",
    vehicleNo: "KL07AB1234",
    vin: "MA3FJEB1S00A12345",
    advisorName: "Maya",
    createdAt: "2026-10-23T10:00:00+05:30",
    status: "paid",
    pageFrom: 1,
    pageTo: 2,
    fileName: "asha-service.pdf",
  },
];

test("normalizes registration numbers", () => {
  assert.equal(normalizeIdentifier("kl 07-ab.1234"), "KL07AB1234");
});

test("filters tiles by date and status", () => {
  assert.deepEqual(dashboardCounts(bills, "2026-10-23"), {
    all: 2,
    paid: 1,
    unpaid: 1,
    needs_review: 0,
  });
  assert.equal(filterBills(bills, "2026-10-23", "unpaid").length, 1);
});

test("searches normalized identifiers and groups connection keys", () => {
  assert.equal(filterBills(bills, "2026-10-23", "all", "kl07ab").length, 2);
  assert.equal(filterBills(bills, "2026-10-23", "all", "Asha").length, 2);
  assert.equal(groupBills(bills)[0].bills.length, 2);
});
