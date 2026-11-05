export type BillStatus = "ready" | "needs_review" | "paid";

export type Bill = {
  id: string;
  uploadId: string;
  connectionKey: string;
  connectionKeyType: "vin" | "vehicle" | "reference" | "unmatched";
  customerName: string;
  vehicleNo: string;
  vin: string;
  invoiceReference?: string;
  advisorName: string;
  createdAt: string;
  status: BillStatus;
  paidAt?: string;
  pageFrom: number;
  pageTo: number;
  fileName: string;
};

export type BillFilter = "all" | "paid" | "unpaid" | "needs_review";

export type BillGroup = {
  key: string;
  bills: Bill[];
  newestAt: string;
};
