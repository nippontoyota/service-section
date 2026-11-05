import { PDFParse } from "pdf-parse";
import { financialFields } from "./financial";
import type { BillDocument } from "../desk";

export type Confidence = "high" | "medium" | "missing";

export type ExtractedBill = {
  amountPaise: number | null;
  invoiceDate: string | null;
  amountEvidence: string;
  paymentEvidence: import("../desk").PaymentEvidence[];
  extractionIssues: string[];
  pageFrom: number;
  pageTo: number;
  vin: string;
  vehicleNo: string;
  customerName: string;
  customerReference: string;
  invoiceReference: string;
  jobCardReference: string;
  document: BillDocument;
  confidence: {
    vin: Confidence;
    vehicleNo: Confidence;
    customerName: Confidence;
  };
};

const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
const VEHICLE = /\b[A-Z]{2}[\s.\-]?\d{1,2}[\s.\-]?[A-Z]{1,3}[\s.\-]?\d{1,4}\b/i;

function normalized(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function labelledValue(text: string, labels: string[], value: RegExp) {
  for (const label of labels) {
    const match = text.match(new RegExp(`(?:${label})\\s*[:#.-]?\\s*(${value.source})`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function customerName(text: string) {
  const direct = text.match(/(?:customer[ \t]*name|bill[ \t]*to)[ \t]*[:#.-]?[ \t]+([^\n\r]{2,80})/i)?.[1]?.trim();
  if (direct && !/^(customer|invoice|address|id\b)/i.test(direct)) return direct;
  const receiver = text.match(/Details of Receiver\s*\(Billed To\)\s*:?\s*\n([^\n]+)(?:\n([^\n]+))?/i);
  if (receiver) return receiver[1].trim();
  for (const line of text.split("\n")) {
    const vehicle = line.match(VEHICLE);
    if (vehicle && vehicle.index && /^[A-Z .]+$/.test(line.slice(0,vehicle.index).trim())) return line.slice(0,vehicle.index).trim();
  }
  // Accessory invoice template: the detached customer-name value precedes Parts Details.
  if (/Customer Name\s*\nCustomer Add\./i.test(text)) return text.match(/\n([A-Z][A-Z &.]+)\s*\nParts Details/i)?.[1] ?? "";
  return "";
}

function reference(text: string, label: RegExp) {
  return text.match(new RegExp(`${label.source}\\s*[:#.-]?\\s*([A-Z0-9\-/]{3,30})`, "i"))?.[1]?.trim() ?? "";
}

function invoiceReference(text: string) {
  const note = text.match(/(?:Warranty Repair Note|AMC Service Note)\s*:?\s*([A-Z]{2,4}\d{2}-\d{4,8})/i)?.[1];
  if (note) return note;
  const labelled = text.match(/(?:invoice|bill)\s*(?:no\.?|number)[ \t]*[:#.-]?[ \t]*([A-Z0-9][A-Z0-9/-]{2,29})/i)?.[1];
  if (labelled && /\d/.test(labelled)) return labelled;
  return text.match(/\b([A-Z]{2,4}\d{2}-\d{4,8})\((?:Cash|Credit|EW)\)/i)?.[1]
    ?? [...text.matchAll(/^\s*([A-Z]{2,4}\d{2}-\d{4,8})\s*$/gim)].find(m => !/^(?:GSJ|BPJ|BPE)/i.test(m[1]))?.[1] ?? "";
}

function cleanName(value: string) {
  return value.replace(/^(?:Mr|Mrs|Ms|M\/s)\.?\s+/i, "").replace(/\s+/g, " ").trim();
}

function parties(text: string) {
  const receiver = text.split(/Details of Receiver\s*\(Billed To\)\s*:?/i)[1]?.split(/Details of Consignee/i)[0] ?? "";
  const consignee = text.split(/Details of Consignee\s*\(Shipped To\)\s*:?/i)[1]?.split(/Place of Supply/i)[0] ?? "";
  const named = (block: string) => block.match(/^(?:Mr|Mrs|Ms|M\/s)\.?[ \t]+[^\n]+/im)?.[0];
  const receiverLines = receiver.split("\n").map(l => l.trim()).filter(l => l && !/\d|@|^(?:Mobile|Telephone|Fax|State|GSTIN|PAN|Policy|A\/C)\b/i.test(l));
  const amcBillTo = /AMC Service Note/i.test(text) ? text.match(/^([A-Z][A-Z &.]+)\s*\nBill To\b/m)?.[1] : "";
  const billedTo = cleanName(named(receiver) || receiverLines[0] || amcBillTo || customerName(text));
  let owner = named(consignee) || consignee.split("\n").map(l => l.trim()).find(l => l && !/^(?:Mobile|Telephone|Fax|GSTIN|State|PAN|Policy)\b/i.test(l)) || "";
  if (/^DIRECTOR$/i.test(owner)) {
    const company = consignee.match(/(?:^|,)\s*([^\n,]*(?:PRIVATE LIMITED|PVT\.? LTD\.?))/im)?.[1];
    if (company) owner = company;
  }
  // AMC exports can place the ship-to name before the Ship To heading.
  if (!owner && /AMC Service Note/i.test(text)) owner = named(text.slice(0, text.indexOf("Series"))) || "";
  return { billedTo, customerName: cleanName(owner || billedTo) };
}

function documentDetails(text: string, invoice: string, job: string, billedTo: string): BillDocument {
  let kind: BillDocument["kind"] = "unknown";
  let billType = "Unclassified document";
  let evidence = "No supported document heading found";
  if (/Warranty Repair Note/i.test(text)) {
    kind = "warranty_note";
    billType = /FREE MAINTENANCE/i.test(text) ? "Free maintenance (FMSC)" : "Warranty repair note";
    evidence = /FREE MAINTENANCE/i.test(text) ? "Warranty Repair Note; FREE MAINTENANCE line item" : "Warranty Repair Note";
  } else if (/AMC Service Note/i.test(text)) {
    kind = "amc_note"; billType = /Smile Adjustment/i.test(text) ? "Toyota Smiles / AMC service note" : "AMC service note"; evidence = "AMC Service Note; AMC line items";
  } else if (/^EW[A-Z]?\d/i.test(invoice)) {
    kind = "invoice";
    billType = /TOYOTA KIRLOSKAR/i.test(billedTo) ? "Extended warranty · Toyota" : /ASSURANT/i.test(billedTo) ? "Extended warranty · Assurant" : "Extended warranty";
    evidence = invoice + "; billed to " + billedTo;
  } else if (/^IN[A-Z]?\d/i.test(invoice) && /insurance|assurance/i.test(text.slice(0, 2200))) {
    kind = "invoice"; billType = /^BPJ/i.test(job) ? "Body & paint · insurance" : "Insurance claim"; evidence = invoice + "; " + job + "; billed to " + billedTo;
  } else if (/^TX[A-Z]?\d/i.test(invoice)) {
    kind = "invoice"; billType = /^BPJ/i.test(job) ? "Body & paint · customer" : "Service invoice";
    evidence = invoice + (job ? "; " + job : "");
    const warranty = text.match(/replaced under\s+(extended\s+)?warranty/i);
    if (warranty && !/^BPJ/i.test(job)) {
      billType = warranty[1] ? "Service · customer portion (extended warranty)" : "Service · customer portion (warranty)";
      evidence += "; " + warranty[0].replace(/\s+/g, " ");
    }
  } else if (/Tax Invoice/i.test(text)) { kind = "invoice"; billType = "Tax invoice"; evidence = "Tax Invoice heading"; }
  return { kind, billType, billedTo, typeEvidence: evidence };
}

export function extractCustomerReference(text: string) {
  const header = text.slice(0, 2200);
  const direct = [...header.matchAll(/customer\s*(?:id|code|number|no\.?)\s*[:#]?\s*([A-Z]?\d{5,16})\b/gi)].map(m => m[1].toUpperCase());
  if (new Set(direct).size === 1) return direct[0];
  if (direct.length || !/customer\s+id/i.test(header)) return "";
  // Detached customer-ID value columns in the supplied dealership layouts.
  const detached = [...header.matchAll(/\b[CI]\d{8}\b/g)].map(m => m[0]);
  if (new Set(detached).size === 1) return detached[0];
  if (/Customer ID Ref\. Doc\. No\. Pay Type Pay Date Discount/i.test(header)) {
    const row = header.match(/^\s*[\d.]+%\s+\d{1,2}\/\d{1,2}\/\d{4}\s+\w+\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+(\d{8})\s*$/m);
    if (row) return row[1];
  }
  return "";
}

function splitRanges(pages: string[]) {
  const starts = [0];
  let previous = invoiceReference(pages[0] ?? "");
  for (let index = 1; index < pages.length; index += 1) {
    const current = invoiceReference(pages[index].slice(0, 2200));
    if (current && current !== previous) { starts.push(index); previous = current; }
  }
  return starts.map((start, index) => ({
    from: start,
    to: (starts[index + 1] ?? pages.length) - 1,
  }));
}

export async function extractBills(data: Uint8Array) {
  // PDF.js transfers its buffer to a worker; preserve the caller's bytes for hashing/storage.
  const parser = new PDFParse({ data: data.slice() });
  let pages: string[] = [];
  let pageCount = 0;
  try {
    const info = await parser.getInfo();
    pageCount = info.pages.length || info.info?.Pages || 0;
    if (pageCount > 100) throw new Error("PDF exceeds the 100-page limit");
    const result = await parser.getText();
    pageCount = result.total;
    pages = result.pages.map((page) => page.text);
  } finally {
    await parser.destroy();
  }

  if (!pages.some((page) => page.trim())) {
    return { pageCount, hasReadableText: false, bills: [emptyBill(1, pageCount)] };
  }

  const bills = splitRanges(pages).map(({ from, to }) => {
    const text = pages.slice(from, to + 1).join("\n");
    const labelledVin = labelledValue(text, ["VIN", "chassis\\s*(?:no|number)"], VIN);
    const joinedVin = text.replace(/\b([A-HJ-NPR-Z0-9]{16})\s*\n\s*([A-HJ-NPR-Z0-9])\b/g, "$1$2");
    const genericVin = joinedVin.match(VIN)?.[0] ?? "";
    const labelledVehicle = labelledValue(text, ["vehicle\\s*(?:no|number)", "registration\\s*(?:no|number)", "reg\\.?\\s*no"], VEHICLE);
    const genericVehicle = text.match(VEHICLE)?.[0] ?? "";
    const party = parties(text);
    const name = party.customerName;
    const vin = normalized(labelledVin || genericVin);
    const vehicleNo = (labelledVehicle || genericVehicle).toUpperCase().trim();

    const invoice = invoiceReference(text);
    const job = reference(text, /job\s*card\s*(?:no|number)?/i) || text.match(/\b(?:GSJ|BPJ)\d{2}-\d{4,8}\b/i)?.[0] || "";
    const document = documentDetails(text, invoice, job, party.billedTo);
    const financial = financialFields(text);
    if (["warranty_note", "amc_note"].includes(document.kind) && financial.amountPaise === null && !financial.amountEvidence) {
      financial.extractionIssues = financial.extractionIssues.filter(issue => !issue.startsWith("Invoice total could not"));
      financial.amountEvidence = "No monetary total stated; covered by " + (document.kind === "amc_note" ? "AMC" : "warranty / free maintenance") + ".";
    }
    return {
      ...financial,
      pageFrom: from + 1,
      pageTo: to + 1,
      vin,
      vehicleNo,
      customerName: name,
      customerReference: extractCustomerReference(text),
      invoiceReference: invoice,
      jobCardReference: job,
      document,
      confidence: {
        vin: labelledVin ? "high" : genericVin ? "medium" : "missing",
        vehicleNo: labelledVehicle ? "high" : genericVehicle ? "medium" : "missing",
        customerName: name ? "high" : "missing",
      },
    } satisfies ExtractedBill;
  });

  return { pageCount, hasReadableText: true, bills };
}

function emptyBill(pageFrom: number, pageTo: number): ExtractedBill {
  return {
    ...financialFields(""),
    pageFrom,
    pageTo,
    vin: "",
    vehicleNo: "",
    customerName: "",
    customerReference: "",
    invoiceReference: "",
    jobCardReference: "",
    document: { kind: "unknown", billType: "Unclassified document", billedTo: "", typeEvidence: "No readable text" },
    confidence: { vin: "missing", vehicleNo: "missing", customerName: "missing" },
  };
}

export function extractedBillFields(bill: ExtractedBill) {
  return {
    amount_paise: bill.amountPaise, invoice_date: bill.invoiceDate, amount_evidence: bill.amountEvidence,
    payment_evidence: bill.paymentEvidence, extraction_issues: bill.extractionIssues,
    vin: bill.vin, vehicle_no_display: bill.vehicleNo, customer_name: bill.customerName,
    customer_reference: bill.customerReference || null, invoice_reference: bill.invoiceReference || null,
    job_card_reference: bill.jobCardReference || null,
    // Keep classification values and evidence with the existing extraction metadata.
    field_confidence: { ...bill.confidence, document: bill.document },
  };
}
