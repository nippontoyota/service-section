// One-time pre-launch reset. Keep the app offline while running this script.
// Dry run by default; --apply backs up records and PDFs before deleting anything.
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const apply = process.argv.includes("--apply");
const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const tables = ["profiles", "staff_credentials", "staff_sessions", "staff_login_attempts", "uploads", "bills",
  "payments", "audit_events", "bill_edit_log", "customers", "purge_runs"];
const keys = { staff_credentials: "staff_id", staff_sessions: "token_hash", staff_login_attempts: "login_id" };
async function rows(table) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await service.from(table).select("*").order(keys[table] ?? "id").range(offset, offset + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}
async function objects(prefix = "") {
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await service.storage.from("bills").list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(error.message);
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) all.push(path);
      else all.push(...await objects(path));
    }
    if (data.length < 100) return all;
  }
}
const snapshot = {};
for (const table of tables) snapshot[table] = await rows(table);
const admin = snapshot.profiles.find(p => p.staff_id === "admin01" && p.role === "super_admin" && p.active && !p.must_change_password);
if (!admin || !snapshot.staff_credentials.some(c => c.staff_id === admin.id)) throw new Error("A usable admin01 account is required; nothing deleted.");
const paths = await objects();
console.log("Project:", new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname);
console.log("Keep:", admin.staff_id);
console.log("Remove accounts:", snapshot.profiles.filter(p => p.id !== admin.id).map(p => p.staff_id));
console.log("Current records:", Object.fromEntries(tables.map(t => [t, snapshot[t].length])), "Stored PDFs:", paths.length);
if (!apply) {
  console.log("Dry run only. Run with --apply to back up and reset.");
  process.exit(0);
}

const backup = resolve("output", "production-reset-" + new Date().toISOString().replaceAll(":", "-"));
await mkdir(backup, { recursive: true, mode: 0o700 });
await writeFile(resolve(backup, "database.json"), JSON.stringify({ project: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname, snapshot, paths }, null, 2), { mode: 0o600 });
for (const [index, path] of paths.entries()) {
  let { data, error } = await service.storage.from("bills").download(path);
  for (let attempt = 0; error && attempt < 2; attempt++) {
    ({ data, error } = await service.storage.from("bills").download(path));
  }
  if (error || !data) throw new Error(`Backup failed for ${path}: ${error?.message}`);
  await writeFile(resolve(backup, `${index}.pdf`), Buffer.from(await data.arrayBuffer()), { mode: 0o600 });
}
console.log("Private backup saved:", backup);

async function remove(table, records) {
  const key = keys[table] ?? "id";
  // A single DELETE handles payment reversal self-references together.
  if (records.length) {
    const { error } = await service.from(table).delete().in(key, records.map(r => r[key]));
    if (error) throw new Error(`Reset stopped at ${table}: ${error.message}. Backup: ${backup}`);
  }
}
await remove("staff_sessions", snapshot.staff_sessions);
for (const table of ["audit_events", "payments", "bill_edit_log", "bills", "uploads", "customers", "purge_runs", "staff_login_attempts"]) {
  await remove(table, snapshot[table]);
  if ((await rows(table)).length) throw new Error(`New ${table} records appeared; stop app traffic before retrying. Backup: ${backup}`);
}
// Credentials and sessions for removed accounts cascade from profiles.
await remove("profiles", snapshot.profiles.filter(p => p.id !== admin.id));
for (let i = 0; i < paths.length; i += 100) {
  const { error } = await service.storage.from("bills").remove(paths.slice(i, i + 100));
  if (error) throw new Error(`PDF deletion failed: ${error.message}. Backup: ${backup}`);
}
const remaining = await rows("profiles");
if (remaining.length !== 1 || remaining[0].id !== admin.id) throw new Error("Unexpected remaining staff accounts.");
const credentials = await rows("staff_credentials");
if (credentials.length !== 1 || credentials[0].password_hash !== snapshot.staff_credentials.find(c => c.staff_id === admin.id).password_hash) throw new Error("Admin credentials verification failed.");
for (const table of tables.filter(t => !["profiles", "staff_credentials"].includes(t))) {
  if ((await rows(table)).length) throw new Error(`Verification failed: ${table} is not empty.`);
}
if ((await objects()).length) throw new Error("Verification failed: bills storage is not empty.");
console.log("Verified: only admin01 remains, its password is unchanged, and bill data, PDFs and sessions are empty.");
