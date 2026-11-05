# PRD: Cashier Bill Finder

# November 2026 scope update

The implemented scope now includes individual staff-ID logins, a super admin workspace, automatic bill amounts, cashier approval, permanent history and drill-down reporting. Manual amount/payment-method entry is excluded. The former 24-hour deletion requirement is retired. See [README.md](README.md) for current behavior; the original pilot requirements are retained below for context.

---


**Status:** Draft v1
**Audience:** Project team (non-code readable)
**Companion document:** `architecture.md`

---

## 1. Problem

In the service department, about 10 service staff prepare customer bills around 10 a.m. The staff member then moves on. Customers usually come to pay much later, often around 6 to 6:30 p.m., at a single cash counter.

The bills currently travel over WhatsApp. When a customer arrives, the cashier has to scroll through chats to work out which bill belongs to which vehicle. This is slow, error-prone, and causes long waiting time for the customer (high turnaround time, TAT) and a heavy mental load for the cashier.

## 2. Goal

Give the cashier one place where every bill for the day is already organised, and where any bill can be found in seconds using what the customer will actually tell them: **VIN, vehicle number, or customer name**.

### Success measures

| Measure | Target |
|---|---|
| Time from customer arriving to bill on screen | Under 15 seconds |
| Bills found without scrolling through WhatsApp | 100% of uploaded bills |
| Service staff upload time per bill | Under 30 seconds |
| Bills correctly auto-read (VIN, vehicle no., name found) | 90% or more of uploaded PDFs |

## 3. Users and roles

Exactly two roles in v1.

**Service Advisor (the "services guy")**
- Uploads one or more bill PDFs
- Sees their own uploads and whether each was read correctly
- Can fix wrong or missing details on their own uploads before the cashier needs them

**Cashier**
- Sees every bill from every service advisor
- Searches, opens, prints, and marks bills as paid
- Can complete or correct searchable fields on an unpaid bill, with every change logged
- Cannot upload bills (keeps the roles clean)

Accounts are created by the project team (no public sign-up). Each person logs in with email and password.

## 4. Core user flows

### 4.1 Service advisor uploads a bill
1. Logs in and lands on the Upload page.
2. Selects one or more PDF files (from phone or computer). A single PDF may contain several bills.
3. The system reads each PDF and shows what it found: VIN, vehicle number, customer name, and how many bills are inside.
4. If something could not be read, the advisor is asked to type it in. Nothing is silently dropped.
5. Advisor confirms. The bill is now visible to the cashier.

### 4.2 Cashier finds and settles a bill
1. Logs in and lands on the Dashboard.
2. The dashboard lists all unpaid bills, newest first, with a live count.
3. Cashier types into one search box. They can enter a VIN (full or the last 6 characters), a vehicle number (any spacing, e.g. `KL07AB1234` or `KL 07 AB 1234`), or part of a customer name.
4. Matching bills appear immediately.
5. Cashier opens the bill, prints it, and after the customer pays, taps **Mark as Paid**.
6. The bill leaves the unpaid list and is scheduled for deletion (see 4.3).

### 4.3 Automatic deletion
- When the cashier marks a bill as paid, the system records the time.
- The bill and its PDF stay recoverable for **24 hours** (the one-day buffer), so a mistaken click can be undone.
- After 24 hours, the bill record and the stored PDF file are permanently deleted automatically.
- For a combined source PDF, expired bill records are deleted after their buffer but the shared file remains until its final contained bill is eligible; the cashier UI exposes only the selected bill pages.

## 5. Functional requirements

### 5.1 Upload and reading
| ID | Requirement |
|---|---|
| U1 | Accept multiple PDF files in one upload action |
| U2 | Read the text inside each PDF and extract VIN, vehicle number, customer name. No OCR and no machine learning. |
| U3 | A single PDF can contain multiple bills; the system must split them and keep them together as one group |
| U4 | Show extraction result to the uploader and allow correction before confirming |
| U5 | If a PDF has no readable text (for example a photo or scan), mark it "Needs manual entry" and let the advisor type the three fields |
| U6 | Reject non-PDF files and files over the size limit with a clear message |
| U7 | Warn if the same file or same bill is uploaded twice |

### 5.2 Connection key (linking bills)
Bills that belong together must be linked so the cashier sees them as one unit for the customer.

| ID | Requirement |
|---|---|
| K1 | Every bill gets a **connection key** used to group related bills |
| K2 | Key priority: VIN first, then vehicle number, then job card or invoice reference if present |
| K3 | Bills from different uploads that share a key are shown together under one customer card |
| K4 | The key is shown in the bill detail so staff can see why bills were grouped |

### 5.3 Cashier dashboard
| ID | Requirement |
|---|---|
| D1 | Default view: all unpaid bills, grouped by connection key, newest first |
| D2 | One search box that accepts VIN, vehicle number, or customer name |
| D3 | Vehicle number search ignores spaces, dashes, and letter case |
| D4 | VIN search works on the full VIN or the last 6 characters |
| D5 | Name search is partial and tolerant of small spelling differences |
| D6 | Each result card shows customer name, vehicle number, VIN, service advisor who uploaded it, upload time, and number of bills |
| D7 | Open a bill to preview the PDF in the browser |
| D8 | Print only the selected bill's pages, not the whole combined PDF |
| D9 | **Mark as Paid** action on a bill or on a whole group |
| D10 | New uploads appear on the dashboard without refreshing the page |
| D11 | Filter tabs: Unpaid, Paid (last 24 hours), Needs review |
| D12 | **Undo** on a paid bill during the 24-hour buffer |

### 5.4 Retention
| ID | Requirement |
|---|---|
| R1 | Paid bills are permanently deleted 24 hours after being marked paid |
| R2 | Deletion removes both the database record and the stored PDF file |
| R3 | Deletion runs automatically, with no manual action |
| R4 | Unpaid bills are never auto-deleted in v1; they are highlighted when older than 48 hours so nothing is forgotten |

## 6. Screens

1. **Login**
2. **Upload** (service advisor): file picker, extraction preview with editable fields, confirm button, list of "my uploads today"
3. **Dashboard** (cashier): search box at the top, unpaid list below, tabs for Unpaid / Paid / Needs review
4. **Bill detail** (cashier): PDF preview, extracted fields, Print, Mark as Paid, Undo

Design notes: the cashier works under time pressure at a counter. The search box is the largest element and focused on page load. Text is large and readable. Primary actions (Print, Mark as Paid) are big and clearly separated so they are not tapped by accident. Service advisors mostly use phones, so the Upload page must work well on a small screen.

## 7. Non-functional requirements

- **Speed:** search results within 1 second for a day's volume
- **Reliability:** an upload is never lost; failed reads fall back to manual entry
- **Privacy:** bills contain customer names and vehicle details. Only logged-in staff can see them. Files are stored privately and served through short-lived links.
- **Simplicity:** no installation; works in a normal browser on phone and desktop
- **Cost:** runs on Supabase and one free-tier-friendly web host

## 8. Out of scope for v1

- OCR or any machine learning
- Reading scanned or photographed bills automatically (manual entry covers this)
- Payment processing or receipts
- WhatsApp integration or automatic import from WhatsApp
- Admin panel, reports, analytics
- More than two roles

## 9. Risks and open questions

| # | Item | Why it matters |
|---|---|---|
| 1 | Are the PDFs created digitally (text inside) or are they scans? | Without OCR, only digital PDFs can be read automatically. **Please test a few real bills.** |
| 2 | Does every bill layout label the VIN, vehicle number and name in the same way? | The reader depends on these labels. Different layouts need different rules. |
| 3 | What exactly is the "connection string" printed on bills (job card number, invoice number, VIN)? | Decides the grouping key. Defaults are in 5.2. |
| 4 | Should unpaid bills ever expire? | v1 keeps them and only flags after 48 hours. |
| 5 | Will there ever be more than one cashier? | The design already supports it, but "who is handling this bill" is not tracked in v1. |

## 10. Rollout

1. **Pilot:** 2 service advisors and the cashier for one week using real bills
2. Collect misread cases, add reading rules for those layouts
3. Roll out to all 10 service advisors

## 11. Acceptance checklist

- [ ] Upload 5 different real PDFs; at least 4 are read correctly without manual typing
- [ ] A PDF with 3 bills is split and shown as one group
- [ ] Cashier finds a bill by VIN, by last 6 of VIN, by vehicle number with spaces, and by half a name
- [ ] Printing a bill prints only its own pages
- [ ] Marking paid removes it from Unpaid; Undo brings it back within 24 hours
- [ ] A paid bill and its file are gone after 24 hours
- [ ] A service advisor cannot open the cashier dashboard
