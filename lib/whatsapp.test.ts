import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { billContacts, customerContactKey, customerPhone, billFilename, customerLinkSeconds, customerShareBills, savedCustomerPhone, shareBillIds, whatsappMessage, whatsappUrl } from "./whatsapp";
import { customerPdf } from "./pdf/customer-copy";
import { fixtureSnapshot } from "./test-fixtures";
import { customerBillCode, customerBillOrigin, hashBillCode, newCustomerBillLink } from "./customer-bill-links";

test("short bill codes are fresh 128-bit secrets; only their SHA-256 hashes are stored", () => {
  const links = Array.from({ length: 100 }, () => newCustomerBillLink("https://billdesk-rho.vercel.app"));
  assert.equal(new Set(links.map(item => item.link)).size, 100);
  for (const { link, codeHash } of links) {
    const code = new URL(link).pathname.slice(3);
    assert.match(code, customerBillCode);
    assert.equal(code.length, 22);
    assert.equal(Buffer.from(code, "base64url").length, 16);
    assert.match(codeHash, /^[a-f0-9]{64}$/);
    assert.equal(codeHash, hashBillCode(code));
  }
  for (const code of ["", "a".repeat(21), "a".repeat(23), "a".repeat(22), "../private.pdf"]) assert(!customerBillCode.test(code));
});

test("customer link origin must be explicitly configured and cannot use request input", () => {
  const previous = process.env.BILLDESK_PUBLIC_URL;
  try {
    for (const origin of ["https://billdesk-rho.vercel.app", "http://127.0.0.1:3119", "http://localhost:3000"]) {
      process.env.BILLDESK_PUBLIC_URL = origin + "/";
      assert.equal(customerBillOrigin(), origin);
    }
    for (const origin of ["", "http://public.example", "https://user:password@example.test", "https://example.test/path", "https://example.test/?x=1", "https://example.test/#fragment"]) {
      process.env.BILLDESK_PUBLIC_URL = origin;
      assert.throws(customerBillOrigin, /not configured/);
    }
  } finally {
    if (previous === undefined) delete process.env.BILLDESK_PUBLIC_URL;
    else process.env.BILLDESK_PUBLIC_URL = previous;
  }
});

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
  const bill = { customer_name: "Asha & family", invoice_reference: "INV/123", invoice_date: "2026-11-14", vehicle_no_display: "KL01AB1234", token_number: "0012", bill_type: "Service invoice" };
  const link = "https://example.test/bill.pdf?token=a&download=1";
  const message = whatsappMessage([{ bill, link }], "Advisor");
  const url = new URL(whatsappUrl("9876543210", message));
  assert.equal(url.origin, "https://wa.me");
  assert.equal(url.pathname, "/919876543210");
  assert.equal(url.searchParams.get("text"), message);
  assert.match(message, /Token number: 0012/);
  assert.match(message, /within 7 days/);
  assert.equal(customerLinkSeconds, 604800);
  assert.match(message, /\*1\. Service invoice — INV\/123\*\nhttps:/);
  assert.equal(whatsappMessage([{ bill: { customer_name: "", invoice_reference: null, invoice_date: null, vehicle_no_display: "", token_number: null }, link }], ""), `Hello, here is your bill.\n\n*1. Bill*\n${link}\n\nPlease download your bill within 7 days.\n\nThank you.`);
});

test("one customer message pairs every bill heading with its own link", () => {
  const first = { ...fixtureSnapshot().bills[0], customer_name: "Customer", bill_type: "Body & paint", invoice_reference: "TXB26-12760", token_number: "001" };
  const second = { ...first, bill_type: "Service invoice", invoice_reference: "TXB26-12748", token_number: "002" };
  const message = whatsappMessage([{ bill: first, link: "https://example.test/body.pdf" }, { bill: second, link: "https://example.test/service.pdf" }], "Advisor");
  assert.match(message, /here are your 2 bills/);
  assert.match(message, /\*1\. Body & paint — TXB26-12760\*\nhttps:\/\/example.test\/body.pdf/);
  assert.match(message, /\*2\. Service invoice — TXB26-12748\*\nhttps:\/\/example.test\/service.pdf/);
  assert.match(message, /Token number: 001/);
  assert.match(message, /Token number: 002/);
  assert.equal((message.match(/https:\/\//g) || []).length, 2);
});

test("sharing includes only submitted bills of the same customer and advisor, once each", () => {
  const first = { ...fixtureSnapshot().bills[0], customer_id: "customer-one" };
  const second = { ...first, id: "second", upload_id: "another-upload" };
  const candidates = [second, second, first,
    { ...first, id: "other-customer", customer_id: "customer-two" },
    { ...first, id: "other-advisor", uploaded_by: "another-advisor" },
    { ...first, id: "draft", uploads: { ...first.uploads!, confirmed_at: null } },
  ];
  assert.deepEqual(customerShareBills(first, candidates).map(b => b.id), [first.id, second.id]);
  assert.deepEqual(customerShareBills({ ...first, customer_id: undefined }, candidates).map(b => b.id), [first.id], "Missing customer IDs must not match by name or phone");
});

test("customer contact entry spans uploads, normalizes saved numbers, and requires resolving conflicts", () => {
  const first = { ...fixtureSnapshot().bills[0], customer_id: "one", customer_phone: "9876543210" };
  const second = { ...first, id: "second", upload_id: "second-pdf", customer_phone: "+91 98765 43210" };
  assert.equal(customerContactKey(first), customerContactKey(second));
  assert.equal(savedCustomerPhone(first, [first, second]), "+919876543210");
  assert.equal(savedCustomerPhone(first, [first, { ...second, customer_phone: "9876543211" }]), "");
  assert.equal(savedCustomerPhone(first, [{ ...second, uploaded_by: "other" }]), "+91 ");
  const unknown = { ...first, customer_id: undefined, customer_reference: null, customer_name: "", vehicle_no_display: "", vin: "" };
  assert.notEqual(customerContactKey(unknown), customerContactKey({ ...unknown, id: "another" }));
});

test("explicit message selections require unique bill IDs and their anchor", () => {
  const first = "00000000-0000-4000-8000-000000000001", second = "00000000-0000-4000-8000-000000000002";
  assert.equal(shareBillIds(undefined, first), undefined);
  assert.deepEqual(shareBillIds([first, second], first), [first, second]);
  for (const selection of [null, [], {}, first, [second], [first, first], [first, 123], [first, "invalid"]]) {
    assert.throws(() => shareBillIds(selection, first), /Select the bills/);
  }
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

test("attachment messages contain no hosted URL or expiry and filenames are safe", () => {
  const bill = { ...fixtureSnapshot().bills[0], invoice_reference: 'INV/123\r\n"x', token_number: "001" };
  const message = whatsappMessage([{ bill }], "Advisor");
  assert.match(message, /PDFs attached/);
  assert.match(message, /Token number: 001/);
  assert.doesNotMatch(message, /https?:|within 7 days/);
  assert.match(billFilename(bill), /^INV-123-x-[a-zA-Z0-9-]+\.pdf$/);
  assert.notEqual(billFilename(bill), billFilename({ ...bill, id: "another" }));
});
