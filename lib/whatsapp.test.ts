import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { billContacts, customerPhone, customerLinkSeconds, whatsappMessage, whatsappUrl } from "./whatsapp";
import { customerPdf } from "./pdf/customer-copy";

test("normalizes Indian and international numbers without guessing invalid inputs", () => {
  for (const phone of ["9876543210", "+91 98765 43210", "91-9876543210", " +91 (98765) 43210 "]) {
    assert.equal(customerPhone(phone), "+919876543210");
  }
  assert.equal(customerPhone("+44 (7700) 900123"), "+447700900123");
  for (const phone of [null, 9876543210, "", "+91", "12345", "+910123456789", "+9198765432100", "9876543210ext1", "+012345678", "+1234567890123456", "+91+9876543210", "1e10"]) {
    assert.throws(() => customerPhone(phone), /valid customer WhatsApp number/);
  }
});

test("sharing choices require either a valid phone or an explicit skip", () => {
  assert.deepEqual(billContacts({ first: { phone: "9876543210", skipWhatsApp: false }, second: { phone: "", skipWhatsApp: true } }), {
    first: { phone: "+919876543210", skipWhatsApp: false }, second: { phone: null, skipWhatsApp: true },
  });
  for (const input of [null, [], { bill: null }, { bill: { phone: "9876543210" } }, { bill: { skipWhatsApp: "true" } }, { bill: { skipWhatsApp: false, phone: "" } }]) assert.throws(() => billContacts(input));
});

test("preset message preserves tokens and safely encodes the recipient and link", () => {
  const bill = { customer_name: "Asha & family", invoice_reference: "INV/123", vehicle_no_display: "KL01AB1234", token_number: "0012" };
  const link = "https://example.test/bill.pdf?token=a&download=1";
  const message = whatsappMessage(bill, link, "Advisor");
  const url = new URL(whatsappUrl("9876543210", message));
  assert.equal(url.origin, "https://wa.me");
  assert.equal(url.pathname, "/919876543210");
  assert.equal(url.searchParams.get("text"), message);
  assert.match(message, /Token number: 0012/);
  assert.match(message, /within 7 days/);
  assert.equal(customerLinkSeconds, 604800);
  assert.equal(whatsappMessage({ customer_name: "", invoice_reference: null, vehicle_no_display: "", token_number: null }, link, ""), `Hello, here is your bill.\n${link}\nPlease download your bill within 7 days.\nThank you.`);
});

test("customer PDF includes only the bill pages, including continuation pages", async () => {
  const source = await PDFDocument.create();
  for (const text of ["CUSTOMER ALPHA", "ALPHA CONTINUATION", "CUSTOMER BRAVO"]) source.addPage().drawText(text);
  source.setTitle("Original combined customer upload");
  const bytes = await source.save();
  for (const [from, to, included, excluded] of [[1, 2, "ALPHA", "BRAVO"], [3, 3, "BRAVO", "ALPHA"]] as const) {
    const output = await customerPdf(bytes, from, to);
    const document = await PDFDocument.load(output);
    assert.equal(document.getPageCount(), to - from + 1);
    assert.notEqual(document.getTitle(), source.getTitle());
    const parser = new PDFParse({ data: output });
    try {
      const text = (await parser.getText()).text;
      assert.match(text, new RegExp(included));
      assert.doesNotMatch(text, new RegExp(excluded));
      if (to === 2) assert.match(text, /CONTINUATION/);
    } finally { await parser.destroy(); }
  }
  for (const [from, to] of [[0, 1], [2, 1], [1, 4], [1.5, 2]]) await assert.rejects(customerPdf(bytes, from, to), /page range/);
});
