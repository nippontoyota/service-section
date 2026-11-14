# Deploy BillDesk to Vercel

Import [nippontoyota/service-section](https://github.com/nippontoyota/service-section) into Vercel with the repository root as the Root Directory and `main` as the production branch.

## Build settings

| Setting | Value |
| --- | --- |
| Framework | Next.js |
| Node.js | 22.x, configured in `package.json` |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | Leave the Next.js default |

`vercel.json` supplies the framework and commands. Commit `package-lock.json` whenever dependencies change. This application needs server functions; do not use a static export.

## Environment variables

Add these in Vercel **Project Settings → Environment Variables** for **Production** before deploying:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL, `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | The server-side Supabase service-role key |
| `SERVICE_DESK_DEMO` | `false` |
| `BILLDESK_PUBLIC_URL` | `https://billdesk-rho.vercel.app` (server-only customer-link origin) |

Use the values from your local `.env.local` or Supabase project settings. Keep the service-role key in Vercel's environment settings, never in source code or a `NEXT_PUBLIC_` variable. No anonymous key, database connection string, or Supabase Auth callback is required for this application's staff login.

For Preview deployments, configure a separate test Supabase project if previews need working logins. Leaving Preview unconfigured displays the setup notice. A preview connected to the production database can change real bills and accounts.

Redeploy after changing environment variables. The public Supabase URL is also a build-time variable.

## Database and storage

For the existing configured Supabase project, keep its records and already-applied migrations. Vercel builds do not run SQL migrations or bootstrap staff.

For a new project, apply these SQL files in order through Supabase SQL Editor:

1. `supabase/migrations/202610230001_initial.sql`
2. `supabase/migrations/202611040001_staff_finance.sql`
3. `supabase/migrations/202611040002_customer_full_payment.sql`
4. `supabase/migrations/202611040003_app_auth.sql`
5. `supabase/migrations/202611050001_atomic_upload_confirmation.sql`
6. `supabase/migrations/202611050002_cashier_mark_paid.sql` (required before deploying the one-step cashier payment flow)
7. `supabase/migrations/202611070001_payment_method_and_token.sql` — apply before deploying the token and payment-method forms; existing records remain unchanged.

The migrations create the private `bills` storage bucket and the staff, customer, billing, session and audit structures. For a new database only, configure `.env.local` locally and run `npm run bootstrap:staff` once. The documented starter passwords are public; replace them before staff use the public deployment. Existing configured staff accounts do not need another bootstrap.

If migrating an older installation, follow the retention instructions in README: disable old purge schedules and deploy the retired purge function. There is no Vercel deletion cron.

## PDF processing

The browser uploads PDFs directly to Supabase using a signed upload URL. The processing function receives the upload ID and downloads the PDF from private storage, so the PDF does not travel through a Vercel request body. Original PDF viewing also uses short-lived Supabase URLs.

Uploads are limited to 10 MB and 100 pages. Digital text PDFs are supported; scanned-image OCR is not included. Processing and administrator re-extraction run on Node.js with a 60-second function duration. `next.config.mjs` explicitly includes the PDF.js worker and native canvas dependencies in API function bundles.

Private PDFs, customer fixtures, local environment files and generated reports are excluded from Git and local Vercel CLI uploads. Production uses Supabase records and storage, not files on the function filesystem.

Keep the private PDF exclusion in `.vercelignore` anchored as `/bills/`. An unanchored `bills` rule also removes `app/api/bills`, causing WhatsApp and draft-deletion requests to return HTML 404 pages. `npm run check:deployment` checks that all API route sources remain included while private files stay excluded.

## Verify after deployment

Before deployment, run `npm ci`, `npm run lint`, `npm test`, `npm run build` and `npm run check:deployment` from a clean checkout. The deployment check parses a synthetic PDF using only the files traced into the function bundle; it does not need Supabase credentials or customer PDFs.

1. Open the HTTPS deployment URL and sign in with a configured staff account.
2. Check advisor, cashier and admin views against the existing data.
3. In a test project, upload a digital PDF, review the extracted customer/type/amount and submit it. Confirm that the same PDF cannot be submitted twice.
4. Check customer grouping, original PDF viewing and sign-out. Test Mark as paid and the move from Overview to Archive only with test invoices.

If the setup notice appears, check the Production environment variables and redeploy. If submission reports that it is temporarily unavailable, verify the final atomic-upload migration. For PDF errors, check Vercel function logs and Supabase storage access.

## Batch uploads and session verification

The one-step cashier payment flow requires `202611050002_cashier_mark_paid.sql`. The batch dialog, PDF caching and server session restoration require no additional migration. Draft PDFs are recovered from existing uploads; local selections must be selected again after a reload. The queue and preview URLs are never written to local storage in production.

The isolated browser regression test requires Playwright (or `PLAYWRIGHT_PATH` pointing to its package, plus `CHROMIUM_PATH` if needed). It starts a temporary backend on port 3120 and a production server on port 3119, and refuses to run against a build configured for a different backend:

```sh
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3120 npm run build
node scripts/check-batch-browser.mjs
npm run build
npm run check:deployment
```

Rebuild with the normal environment after the isolated test. The existing `scripts/check-browser.mjs` covers the actual parser and full financial workflow against an explicitly enabled local demo server; `scripts/check-database.mjs` runs against isolated PGlite via `PGLITE_PATH`.

PDF link responses include `uploadId`, `expiresAt`, and authorization/signing durations in milliseconds, also exposed through `Server-Timing`. Browser Performance entries named `pdf-authorization`, `pdf-signing`, `pdf-download`, and `pdf-display` can be inspected separately. Authorization includes session and bill access checks; display measures the native viewer's iframe load event, not a guaranteed first-pixel render time. Local file previews skip authorization, signing, and download. The browser test prints controlled first-view measurements; actual network and device performance varies. Hosting regions are unchanged.

## Configuration references

- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Function duration configuration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Next.js output file tracing](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)

## Admin-chosen staff passwords

Apply `supabase/migrations/202611100001_admin_chosen_password.sql` before deploying this version. Admins enter a user ID and a 6–8 character password (any characters; no complexity requirements) for any staff role. New accounts can sign in immediately; password resets continue to require a first-login password change. Only salted hashes are stored in the shared database.

For the one-time production cleanup, `node --env-file=.env.local scripts/reset-production.mjs` previews the configured project and record counts. With `--apply`, it backs up database records and every object in the `bills` bucket under the ignored, private `output/production-reset-<timestamp>/` directory, then removes bill data and all staff except the active `admin01` account, including legacy Supabase Auth accounts for other users. Its password stays unchanged; existing sessions are revoked. Keep app traffic stopped during the reset. The backup's `database.json` maps each numbered PDF to its original storage path. The reset is separate from migrations and never runs during deployment.

## Transaction IDs and account deletion

Apply `supabase/migrations/202611100002_transaction_id_and_delete_staff.sql` before deploying transaction ID entry and Delete account. It adds an optional payment reference, preserves it on reversals, and enables permanent profile/credential/session deletion by super admins. Existing bills, PDFs, collections and audit history are retained; references to deleted staff become null. The signed-in account and `admin01` are protected. This migration does not perform the one-time data reset.

Apply `supabase/migrations/202611100003_required_payment_references.sql` for mandatory GPay and Demand Draft transaction IDs and cheque numbers. Validation runs in the cashier form, server and collection RPC. Historical payments remain unchanged and can still be reversed; Cash and Other do not require or save references.


## Customer bill delivery

Customer bill delivery is handled outside BillDesk. Advisors upload/read PDFs, review details and tokens, then choose **Submit to cashier** or **Submit all to cashier**. There are no advisor phone fields, sharing queues, message previews or attachment-sharing controls. Old browser sharing queues are cleared on login.

This release requires no new migration or environment variable. Keep previously applied migrations: the confirmation endpoint uses the existing atomic `app_confirm_upload` transaction with server-derived no-sharing contacts. It ignores any old client phone/sharing payload. The existing RPC still records its legacy `whatsapp_skipped` audit event; no new message or PDF copy is prepared. Token requirements, confirmation retry handling and the duplicate-PDF constraint remain unchanged.

`POST /api/bills/[id]/whatsapp` and `GET /api/bills/[id]/attachment` return HTTP 410 so older clients cannot create new bill shares. The existing `/b/[code]` reader remains available for already-issued links until expiry, and staff original-PDF viewing continues normally. No historical records or PDFs are deleted by this release.

Cashier gate-pass WhatsApp remains enabled. Its number field starts blank, uses only the cashier's current entry, and clears a prepared handoff when that entry changes. It does not read `bills.customer_phone`. Gate-pass phone validation, payment clearance, QR generation and security verification remain unchanged.

Run the advisor regression (`scripts/check-whatsapp-browser.mjs`), batch upload, auth and gate-pass browser checks using the isolated backend. They never send WhatsApp messages or modify production data.

## Short customer bill links

Apply the additive `supabase/migrations/202611140001_customer_bill_links.sql` before deploying the short-link route. It creates `customer_bill_links` with row-level security and no anonymous/authenticated grants; only the service role can read or write mappings. No raw codes are stored. Existing bills and signed links are unchanged.

Set server-only `BILLDESK_PUBLIC_URL=https://billdesk-rho.vercel.app` in Production, then deploy. Preview/test deployments must use their own explicit origin (the isolated browser test sets `http://127.0.0.1:3119`). This origin remains required for gate-pass creation. Never derive this origin from the request host.

`GET` and `HEAD /b/[code]` validate the code and expiry before storage access. Responses use a generic inline PDF filename, private/no-store caching, no-index and no-referrer headers. The PDF body is streamed without redirects or storage headers, following [Vercel streaming guidance](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions). HEAD/preview requests do not consume a link. Invalid links return 404, expired links 410, and database/storage outages 503 without internal details. An upstream interruption after streaming starts ends the download; the customer can retry the same link.

The legacy link reader is retained for previously issued links; new customer bill links are no longer created.


## QR gate passes

Apply `supabase/migrations/202611140002_gate_passes.sql` after all earlier migrations and before this application release. It adds the Security role, private pass/coverage tables, transactional issuance and exit confirmation, payment-reversal revocation, and a shared transaction lock for bill, payment and submission writes. It retains all existing records. The global lock is intended for a single service desk; review contention before increasing write throughput substantially.

Set server-only `GATE_PASS_SIGNING_SECRET` to at least 32 random bytes (for example, generate with `openssl rand -hex 32`) and retain it across deployments. Do not use a `NEXT_PUBLIC_` name. Set `BILLDESK_PUBLIC_URL` to the exact HTTPS production origin. The HMAC secret reproduces existing codes for resends; changing it requires revoking all unused passes and reissuing them after payment checks. Do not rotate it silently while active passes exist.

Deploy, then use **Staff accounts → Create account → Security** to create named guard accounts. The Security role must not be created before the new server code is deployed: older server versions do not know this role. Never roll back to an older server while Security accounts are active; disable them and revoke their sessions first. Migration rollback is unnecessary for an application rollback and would remove audit records.

Verification commands:

```sh
npm test
npm run lint
npm run build
npm run check:deployment
# Build against the isolated backend before browser integration checks:
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3120 npm run build
# Install PGlite/Playwright in a separate test tools directory, or provide their absolute package paths.
PGLITE_PATH=/path/to/node_modules/@electric-sql/pglite npm run test:database
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node scripts/check-gate-passes-browser.mjs
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node scripts/check-whatsapp-browser.mjs
```

The gate-pass browser check starts an isolated backend and Next server on ports 3120/3131, uses synthetic customer data, decodes the generated QR, denies camera access, and exercises HTTP role restrictions and the WhatsApp fallback without opening WhatsApp. The database suite uses PGlite to verify migration behavior and permissions. `scripts/check-gate-pass-concurrency.mjs` tests independent PostgreSQL connections: simultaneous issuance and confirmation, reversal/submission locks, and reissuance while an exit commits. Set `PG_TEST_URL` to a disposable **local** PostgreSQL maintenance database and optionally `PG_TEST_DRIVER` to the installed `pg` package path. It creates and drops a uniquely named synthetic database; the maintenance user needs database-creation privileges. For example:

```sh
PG_TEST_URL=postgresql://test_user@127.0.0.1:55439/postgres PG_TEST_DRIVER=/path/to/node_modules/pg node scripts/check-gate-pass-concurrency.mjs
```

Pilot using synthetic bills and two phones on HTTPS: collect all bills across two advisors for the same vehicle; issue and send to a controlled test recipient; open the QR on the customer phone; scan on the guard phone; compare the registration and confirm once. Re-scan, reverse a payment, add another unpaid bill, and test camera denial and disconnected verification. No unavailable/expired/revoked/used pass may approve departure. The public page and link previews are read-only; a valid scan never confirms an exit by itself.

Do not run the historical production-reset script against an installation with gate-pass audit history. Covered bills are deliberately protected from deletion by foreign keys.

## Submission and operation feedback

Full-screen loading is reserved for sign-in/out, PDF upload/read and cashier WhatsApp gate-pass preparation. Advisor submissions use inline pending feedback and the existing brief success screen. Successful batches close advisor dialogs; partial failures preserve the retry queue. Timed-out writes require a status refresh before retrying. Cashier payment details stay open after collection.

Batch PDF uploads now use four concurrent upload/read workers in the connected workspace (two in the local demo); confirmations continue to use two workers. The operation dialog shows the percentage of PDFs successfully ready for review, each file’s state, and byte-based upload percentages. Server-side reading has no fabricated per-page percentage. Failed PDFs do not increase the ready count. This update has no API, database, parser, or extraction-rule changes.

## Loading feedback

Full-screen pending feedback is reserved for sign-in/out, PDF upload/read, and cashier WhatsApp gate-pass preparation. Other actions use inline status and existing action locks. All confirmed successful actions retain the brief success screen; failures and uncertain writes retain their recovery flow. Advisor submission stays inline. The four-worker PDF pipeline and real ready/total percentage are unchanged.
