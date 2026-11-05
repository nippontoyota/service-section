import type { Bill, BillFilter, BillGroup } from "./types";

export function normalizeIdentifier(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function localDateKey(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function billMatchesSearch(bill: Bill, query: string) {
  const raw = query.trim();
  if (!raw) return true;

  const normalized = normalizeIdentifier(raw);
  const searchable = [
    normalizeIdentifier(bill.vin),
    normalizeIdentifier(bill.vehicleNo),
    normalizeIdentifier(bill.invoiceReference ?? ""),
  ];

  return (
    searchable.some((value) => value.includes(normalized)) ||
    bill.customerName.toLocaleLowerCase().includes(raw.toLocaleLowerCase())
  );
}

export function filterBills(
  bills: Bill[],
  date: string,
  filter: BillFilter,
  query = "",
) {
  return bills.filter((bill) => {
    if (localDateKey(bill.createdAt) !== date || !billMatchesSearch(bill, query)) {
      return false;
    }
    if (filter === "paid") return bill.status === "paid";
    if (filter === "unpaid") return bill.status !== "paid";
    if (filter === "needs_review") return bill.status === "needs_review";
    return true;
  });
}

export function groupBills(bills: Bill[]): BillGroup[] {
  const groups = new Map<string, Bill[]>();
  for (const bill of bills) {
    groups.set(bill.connectionKey, [...(groups.get(bill.connectionKey) ?? []), bill]);
  }

  return [...groups.entries()]
    .map(([key, groupedBills]) => ({
      key,
      bills: groupedBills.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      newestAt: groupedBills.reduce(
        (latest, bill) => (bill.createdAt > latest ? bill.createdAt : latest),
        groupedBills[0].createdAt,
      ),
    }))
    .sort((a, b) => b.newestAt.localeCompare(a.newestAt));
}

export function dashboardCounts(bills: Bill[], date: string) {
  const dated = bills.filter((bill) => localDateKey(bill.createdAt) === date);
  return {
    all: dated.length,
    paid: dated.filter((bill) => bill.status === "paid").length,
    unpaid: dated.filter((bill) => bill.status !== "paid").length,
    needs_review: dated.filter((bill) => bill.status === "needs_review").length,
  };
}
