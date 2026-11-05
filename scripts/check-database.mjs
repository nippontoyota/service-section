// Optional isolated PostgreSQL verification. Set PGLITE_PATH to an installed pglite package.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const location = process.env.PGLITE_PATH;
const { PGlite } = await import(location ? location + "/dist/index.js" : "@electric-sql/pglite");
const { pg_trgm } = await import(location ? location + "/dist/contrib/pg_trgm.js" : "@electric-sql/pglite/contrib/pg_trgm");
const db = new PGlite({ extensions:{ pg_trgm } });
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
create publication supabase_realtime;
`);
await db.exec(readFileSync("supabase/migrations/202610230001_initial.sql","utf8"));
await db.exec(readFileSync("supabase/migrations/202611040001_staff_finance.sql","utf8"));
const advisor="00000000-0000-4000-8000-000000000001";
const cashier="00000000-0000-4000-8000-000000000002";
const admin="00000000-0000-4000-8000-000000000003";
const upload="00000000-0000-4000-8000-000000000004";
const bill="00000000-0000-4000-8000-000000000005";
for(const [id, role] of [[advisor,"service_advisor"],[cashier,"cashier"],[admin,"super_admin"]]){
  await db.query("insert into auth.users(id) values($1)",[id]);
  await db.query("insert into profiles(id,staff_id,full_name,role,must_change_password) values($1,$2,$2,$2,false)",[id,role]);
}
await db.query("insert into uploads(id,uploaded_by,storage_path,original_filename,status,confirmed_at) values($1,$2,'test.pdf','test.pdf','confirmed',now())",[upload,advisor]);
await db.query(`insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,invoice_reference,invoice_date,amount_paise,payment_evidence,extraction_issues)
values($1,$2,$3,1,1,'test','reference','INV-1','2026-11-04',2000000,'[{"amount_paise":500000,"date":"2026-11-04","method":"cash"}]','[]')`,[bill,upload,advisor]);
const legacyFull="00000000-0000-4000-8000-000000000008";
const legacyPartial="00000000-0000-4000-8000-000000000009";
for (const id of [legacyFull,legacyPartial]) {
 await db.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,invoice_reference,invoice_date,amount_paise,approval_status) values($1,$2,$3,1,1,'legacy','reference',$1::uuid::text,'2026-11-04',2000000,'approved')",[id,upload,advisor]);
 await db.query("insert into payments(bill_id,amount_paise,recorded_by,source) values($1,500000,$2,'document')",[id,cashier]);
}
await db.query("insert into payments(bill_id,amount_paise,recorded_by,source) values($1,1500000,$2,'document')",[legacyFull,cashier]);
await db.exec(readFileSync("supabase/migrations/202611040002_customer_full_payment.sql","utf8"));
assert.equal((await db.query("select count(*) as n from payments where is_archived")).rows[0].n,3);
assert.equal((await db.query("select count(*) as n from payments where bill_id=$1 and not is_archived",[legacyPartial])).rows[0].n,0);
const consolidated=(await db.query("select amount_paise from payments where bill_id=$1 and not is_archived",[legacyFull])).rows;
assert.equal(consolidated.length,1);
assert.equal(consolidated[0].amount_paise,2000000);
await db.exec("grant usage on schema public,auth,storage to authenticated,anon; grant select,insert,update,delete on all tables in schema public to authenticated; grant select on storage.objects to authenticated; grant execute on all functions in schema auth to authenticated;");
async function asUser(id) { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec("set role authenticated"); }
async function action(name,id,reason=""){return db.query("select desk_action($1,$2,$3)",[name,id,reason]);}
await asUser(advisor);
await assert.rejects(action("approve",bill),/Cashier/);
const denied = await db.query("update bills set amount_paise=1 where id=$1 returning id",[bill]);
assert.equal(denied.rows.length,0);
await asUser(cashier);
await assert.rejects(action("collect",bill),/Approve/);
await action("approve",bill); await action("approve",bill);
let payments = await db.query("select * from payments where bill_id=$1",[bill]);
assert.equal(payments.rows.length,0);
await action("collect",bill); await action("collect",bill);
payments = await db.query("select * from payments where bill_id=$1",[bill]);
assert.equal(payments.rows.length,1);
assert.equal(payments.rows.reduce((s,p)=>s+Number(p.amount_paise),0),2000000);
const settled = await db.query("select status,delete_after from bills where id=$1",[bill]);
assert.equal(settled.rows[0].status,"paid"); assert.equal(settled.rows[0].delete_after,null);
await assert.rejects(action("reverse",payments.rows[0].id,"Wrong entry"),/Admin/);
await asUser(admin);
await action("reverse",payments.rows[0].id,"Wrong bill");
await action("reverse",payments.rows[0].id,"Retry");
const snapshot = (await db.query("select desk_snapshot() as data")).rows[0].data;
assert.equal(snapshot.payments.filter(p=>p.bill_id===bill).length,2);
assert.equal(snapshot.payments.filter(p=>p.bill_id===bill).reduce((s,p)=>s+p.amount_paise,0),0);
assert.equal(snapshot.audit.filter(a=>a.bill_id===bill).length,3);
await db.exec("reset role");
await assert.rejects(db.query("insert into payments(bill_id,amount_paise,recorded_by,source) values($1,100,$2,'cashier')",[bill,cashier]),/invoice total/);
await db.query("update bills set customer_reference='C16008923',customer_name='Asha Nair' where id=$1",[bill]);
const other="00000000-0000-4000-8000-000000000006";
await db.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,invoice_reference,customer_reference,customer_name,vin) values($1,$2,$3,1,1,'test','reference','INV-2','C16008923','Asha Nair','MA3FJEB1S00A99999')",[other,upload,advisor]);
const grouped=await db.query("select count(distinct customer_id) as customers from bills where id in ($1,$2)",[bill,other]);
assert.equal(grouped.rows[0].customers,1);
await db.query("update bills set customer_reference='C16008924' where id=$1",[other]);
assert.equal((await db.query("select count(distinct customer_id) as customers from bills where id in ($1,$2)",[bill,other])).rows[0].customers,2);
await db.query("update bills set customer_reference=null,customer_name='Same name',vin='',vehicle_no_display='' where id in ($1,$2)",[bill,other]);
assert.equal((await db.query("select count(distinct customer_id) as customers from bills where id in ($1,$2)",[bill,other])).rows[0].customers,2);
await db.query("update profiles set active=false where id=$1",[cashier]);
await asUser(cashier);
await assert.rejects(action("collect",bill),/Active staff/);
assert.equal((await db.query("select desk_snapshot() as data")).rows[0].data.bills.length,0);
await db.exec("reset role");
await db.query("update profiles set active=true,must_change_password=true where id=$1",[cashier]);
await asUser(cashier);
await assert.rejects(action("collect",bill),/Active staff/);
await db.exec("reset role; set role anon;");
await assert.rejects(db.query("select desk_snapshot()"),/permission denied/);
await db.exec("reset role");
const billCount = (await db.query("select count(*) as n from bills")).rows[0].n;
await db.exec(readFileSync("supabase/migrations/202611040003_app_auth.sql","utf8"));
assert.equal((await db.query("select count(*) as n from bills")).rows[0].n, billCount);
const hash = "scrypt$32768$8$3$" + "a".repeat(32) + "$" + "b".repeat(128);
const newHash = "scrypt$32768$8$3$" + "c".repeat(32) + "$" + "d".repeat(128);
for (const [id, role] of [[advisor,"service_advisor"],[cashier,"cashier"],[admin,"super_admin"]]) {
 assert.equal((await db.query("select app_bootstrap_staff($1,$1,$1,$2) as added", [role, hash])).rows[0].added,true);
 assert.equal((await db.query("select id from profiles where staff_id=$1",[role])).rows[0].id,id);
 assert.equal((await db.query("select app_bootstrap_staff($1,$1,$1,$2) as added", [role, newHash])).rows[0].added,false);
}
await db.exec("grant usage on schema public to service_role; set role service_role");
const adminSnapshot = (await db.query("select app_desk_snapshot($1) as data",[admin])).rows[0].data;
assert.equal(adminSnapshot.bills.length,billCount);
assert.ok(!JSON.stringify(adminSnapshot).includes(hash));
await assert.rejects(db.query("select app_desk_action($1,'approve',$2,'')",[advisor,bill]),/Cashier/);
await db.query("select app_desk_action($1,'collect',$2,'')",[cashier,bill]);
const newId = (await db.query("select app_staff_account($1,'create_staff',null,$2,'advisor02','Second Advisor','service_advisor') as id",[admin,hash])).rows[0].id;
assert.equal((await db.query("select count(*) as n from profiles where id=$1",[newId])).rows[0].n,1);
await assert.rejects(db.query("select app_desk_snapshot($1)",[newId]),/Active staff/);
await assert.rejects(db.query("select app_staff_account($1,'reset_staff',$2,$3)",[cashier,newId,hash]),/Super admin/);
await db.query("select app_open_session($1,$2,$3)",[newId,hash,"1".repeat(64)]);
await db.query("select app_staff_account($1,'password',null,$2)",[newId,newHash]);
assert.equal((await db.query("select count(*) as n from staff_sessions where staff_id=$1",[newId])).rows[0].n,0);
assert.equal((await db.query("select app_desk_snapshot($1) as data",[newId])).rows[0].data.bills.length,0);
await assert.rejects(db.query("select app_open_session($1,$2,$3)",[newId,hash,"2".repeat(64)]),/Credentials changed/);
await db.query("select app_open_session($1,$2,$3)",[newId,newHash,"3".repeat(64)]);
await db.query("select app_staff_account($1,'reset_staff',$2,$3)",[admin,newId,hash]);
assert.equal((await db.query("select count(*) as n from staff_sessions where staff_id=$1",[newId])).rows[0].n,0);
await db.query("select app_open_session($1,$2,$3)",[newId,hash,"4".repeat(64)]);
await db.query("select app_staff_account($1,'toggle_staff',$2,enabled=>false)",[admin,newId]);
assert.equal((await db.query("select count(*) as n from staff_sessions where staff_id=$1",[newId])).rows[0].n,0);
await assert.rejects(db.query("select app_open_session($1,$2,$3)",[newId,hash,"5".repeat(64)]),/Active staff/);
for(let i=0;i<11;i++) assert.equal((await db.query("select app_login_attempt('cashier01') as allowed")).rows[0].allowed,i<10);
for(const role of ['anon','authenticated']) {
 await db.exec("reset role; set role " + role);
 for(const query of ["select * from staff_credentials","select * from staff_sessions","select * from bills","select desk_snapshot()",`select app_desk_snapshot('${admin}')`,`select app_bootstrap_staff('evil','Evil','super_admin','${hash}')`]) {
  await assert.rejects(db.query(query),/permission denied/);
 }
}
await db.exec("reset role");
assert.equal((await db.query("select count(*) as n from auth.users where id=$1",[newId])).rows[0].n,0);
// Submission is atomic: one confirmed upload per PDF hash, with retry-safe auditing.
await db.exec(readFileSync("supabase/migrations/202611050001_atomic_upload_confirmation.sql", "utf8"));
async function draft(fileHash, owner = advisor, withBill = true) {
 const id = randomUUID();
 await db.query("insert into uploads(id,uploaded_by,storage_path,original_filename,status,file_hash) values($1,$2,$3,'renamed.pdf','review',$4)", [id,owner,id + ".pdf",fileHash]);
 if (withBill) await db.query("insert into bills(upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,invoice_reference,job_card_reference) values($1,$2,1,1,'test','reference',$3,'SAME-JOB')",[id,owner,"CONF-" + id]);
 return id;
}
const firstDraft = await draft("a".repeat(64));
const duplicateDraft = await draft("a".repeat(64));
const differentDraft = await draft("b".repeat(64));
const noHash = await draft(null);
const noBills = await draft("c".repeat(64), advisor, false);
const otherAdvisor = randomUUID();
await db.query("insert into profiles(id,staff_id,full_name,role,must_change_password) values($1,'otheradvisor','Other Advisor','service_advisor',false)",[otherAdvisor]);
const crossAdvisor = await draft("a".repeat(64), otherAdvisor);
await db.exec("set role service_role");
const confirm = (id, staff = advisor) => db.query("select to_jsonb(app_confirm_upload($1,$2)) as upload",[staff,id]);
await assert.rejects(confirm(firstDraft,cashier), /Service advisor/);
await assert.rejects(confirm(firstDraft,otherAdvisor), /Upload not found/);
await assert.rejects(confirm(noHash), /finish processing/);
await assert.rejects(confirm(noBills), /no extracted bills/);
const attempts = await Promise.allSettled([confirm(firstDraft),confirm(duplicateDraft)]);
assert.equal(attempts.filter(r=>r.status === "fulfilled").length,1);
const rejected = attempts.find(r=>r.status === "rejected");
assert.equal(rejected.reason.code,"23505");
assert.match(rejected.reason.message,/uploads_confirmed_hash_unique/);
const winner = attempts[0].status === "fulfilled" ? firstDraft : duplicateDraft;
const loser = winner === firstDraft ? duplicateDraft : firstDraft;
const original = (await confirm(winner)).rows[0].upload;
const retry = (await confirm(winner)).rows[0].upload;
assert.equal(original.confirmed_at,retry.confirmed_at);
const events = await db.query("select count(*) as n from audit_events where action='submitted' and bill_id in (select id from bills where upload_id=$1)",[winner]);
assert.equal(events.rows[0].n,1,"Retries must not duplicate submitted events");
const lost = (await db.query("select status,confirmed_at from uploads where id=$1",[loser])).rows[0];
assert.deepEqual(lost,{status:"review",confirmed_at:null});
assert.equal((await db.query("select count(*) as n from audit_events where action='submitted' and bill_id in (select id from bills where upload_id=$1)",[loser])).rows[0].n,0);
await assert.rejects(confirm(crossAdvisor,otherAdvisor), /uploads_confirmed_hash_unique/);
await confirm(differentDraft); // Same job reference, different PDF: valid supporting document.
await assert.rejects(db.query("update uploads set confirmed_at=now(),status='confirmed' where id=$1",[loser]), /uploads_confirmed_hash_unique/);
// An audit failure rolls back the upload confirmation as well.
await db.exec("reset role");
const failedAudit = await draft("d".repeat(64));
const auditBill = (await db.query("select id from bills where upload_id=$1",[failedAudit])).rows[0].id;
await db.exec(`alter table audit_events add constraint reject_test_audit check (bill_id <> '${auditBill}')`);
await db.exec("set role service_role");
await assert.rejects(confirm(failedAudit),/reject_test_audit/);
assert.equal((await db.query("select confirmed_at from uploads where id=$1",[failedAudit])).rows[0].confirmed_at,null);
await db.exec("reset role; alter table audit_events drop constraint reject_test_audit");
for (const role of ["anon","authenticated"]) {
 await db.exec("set role " + role);
 await assert.rejects(confirm(winner),/permission denied/);
 await db.exec("reset role");
}
console.log("Upload confirmation passed: duplicate hashes, cross-advisor duplicates, retries, ownership, same-job distinct files, audit rollback and role restrictions.");
await db.close();
console.log("All migrations passed: bill history, financial workflow, app credentials, role boundaries, session revocation, rate limiting and legacy Auth denial.");
