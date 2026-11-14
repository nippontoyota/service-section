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
// Draft deletion claims an unsubmitted review upload before removing any bill.
const deleteDraft = await draft("e".repeat(64));
const claimDelete = (id, owner = advisor) => db.query("update uploads set status='processing' where id=$1 and uploaded_by=$2 and status='review' and confirmed_at is null returning id", [id, owner]);
assert.equal((await claimDelete(deleteDraft, otherAdvisor)).rows.length, 0);
assert.equal((await claimDelete(winner)).rows.length, 0, "Submitted uploads cannot be deleted");
const deletionAttempts = await Promise.all([claimDelete(deleteDraft), claimDelete(deleteDraft)]);
assert.equal(deletionAttempts.reduce((sum, r) => sum + r.rows.length, 0), 1);
await assert.rejects(confirm(deleteDraft), /finish processing/, "Submission cannot race draft deletion");
const sibling = randomUUID();
await db.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type) values($1,$2,$3,2,2,'test','reference')", [sibling, deleteDraft, advisor]);
await db.query("delete from bills where upload_id=$1 and id<>$2 and uploaded_by=$3 and approval_status='pending'", [deleteDraft,sibling,advisor]);
assert.equal((await db.query("select count(*) as n from bills where upload_id=$1",[deleteDraft])).rows[0].n,1,"Deleting one bill preserves the other PDF pages");
await db.query("update uploads set status='review' where id=$1 and status='processing' and confirmed_at is null",[deleteDraft]);
await confirm(deleteDraft);
assert.equal((await claimDelete(deleteDraft)).rows.length,0);
console.log("Draft deletion passed: owner scope, submitted protection, exclusive claims, submit race and multi-bill preservation.");
// Removing a whole unsubmitted PDF preserves every other upload and its history.
const wholeDraft = await draft("f".repeat(64));
await db.query("insert into bills(upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type) values($1,$2,2,2,'test','reference')", [wholeDraft,advisor]);
const beforeWholeDelete = (await db.query("select count(*) as n from bills")).rows[0].n;
assert.equal((await claimDelete(wholeDraft)).rows.length,1);
await db.query("delete from uploads where id=$1 and status='processing' and confirmed_at is null", [wholeDraft]);
assert.equal((await db.query("select count(*) as n from bills where upload_id=$1", [wholeDraft])).rows[0].n,0);
assert.equal((await db.query("select count(*) as n from bills")).rows[0].n,beforeWholeDelete-2);
assert.ok((await db.query("select confirmed_at from uploads where id=$1", [winner])).rows[0].confirmed_at);
console.log("Whole-PDF draft removal passed: cascade restricted to the selected unsubmitted upload; submitted history preserved.");
// One cashier action approves and pays; retries, validation and reversals stay atomic.
await db.exec("reset role");
await db.exec(readFileSync("supabase/migrations/202611050002_cashier_mark_paid.sql", "utf8"));
await db.exec("set role service_role");
const singleStep = randomUUID();
await db.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,invoice_reference,invoice_date,amount_paise) values($1,$2,$3,1,1,'test','reference','ONE-STEP','2026-11-05',12500)", [singleStep,upload,advisor]);
const collect = (id, actor = cashier) => db.query("select app_desk_action($1,'collect',$2,'')", [actor,id]);
await assert.rejects(collect(singleStep,advisor), /Cashier/);
await Promise.all([collect(singleStep),collect(singleStep)]);
const paidBill = (await db.query("select * from bills where id=$1",[singleStep])).rows[0];
assert.equal(paidBill.approval_status,"approved"); assert.equal(paidBill.status,"paid");
assert.equal(paidBill.approved_by,cashier); assert.equal(paidBill.paid_by,cashier);
assert.ok(paidBill.approved_at); assert.ok(paidBill.paid_at);
assert.equal((await db.query("select count(*) as n from payments where bill_id=$1",[singleStep])).rows[0].n,1);
assert.equal((await db.query("select count(*) as n from audit_events where bill_id=$1 and action='collect'",[singleStep])).rows[0].n,1);
const fullPayment = (await db.query("select id from payments where bill_id=$1",[singleStep])).rows[0].id;
await db.query("select app_desk_action($1,'reverse',$2,'Test correction')",[admin,fullPayment]);
assert.equal((await db.query("select status from bills where id=$1",[singleStep])).rows[0].status,"ready");
await collect(singleStep);
assert.equal((await db.query("select sum(amount_paise) as n from payments where bill_id=$1",[singleStep])).rows[0].n,"12500");
const invalidBill = randomUUID();
await db.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,invoice_reference,invoice_date,amount_paise) values($1,$2,$3,1,1,'test','reference','INVALID-STEP','2026-11-05',null)",[invalidBill,upload,advisor]);
await assert.rejects(collect(invalidBill),/Readable invoice/);
await db.query("update bills set amount_paise=100, invoice_reference='ONE-STEP' where id=$1",[invalidBill]);
await assert.rejects(collect(invalidBill),/unique/);
assert.equal((await db.query("select approval_status from bills where id=$1",[invalidBill])).rows[0].approval_status,"pending");
assert.equal((await db.query("select count(*) as n from payments where bill_id=$1",[invalidBill])).rows[0].n,0);
await db.query("update bills set amount_paise=0, invoice_reference='ZERO-STEP' where id=$1",[invalidBill]);
await collect(invalidBill);
assert.equal((await db.query("select status from bills where id=$1",[invalidBill])).rows[0].status,"paid");
assert.equal((await db.query("select count(*) as n from payments where bill_id=$1",[invalidBill])).rows[0].n,0);
console.log("Single-step payment passed: approval, full collection, concurrent retries, reversal, validation, duplicate rollback and zero totals.");
// Payment methods and manual tokens are saved with their existing atomic actions.
await db.exec("reset role");
await db.exec(readFileSync("supabase/migrations/202611070001_payment_method_and_token.sql", "utf8"));
const tokenDraft = await draft("7".repeat(64));
const tokenBill = (await db.query("select id from bills where upload_id=$1", [tokenDraft])).rows[0].id;
const tokenSibling = randomUUID();
await db.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type) values($1,$2,$3,2,2,'test','reference')", [tokenSibling,tokenDraft,advisor]);
await db.exec("set role service_role");
const confirmTokens = (tokens, staff = advisor, id = tokenDraft) => db.query("select app_confirm_upload($1,$2,$3::jsonb)", [staff,id,JSON.stringify(tokens)]);
await assert.rejects(confirmTokens({ [tokenBill]: "0012" }, cashier), /Service advisor/);
await assert.rejects(confirmTokens({ [tokenBill]: "0012" }, otherAdvisor), /Upload not found/);
for (const tokens of [[], { [tokenBill]: 12 }, { [tokenBill]: "x".repeat(31) }, { [singleStep]: "12" }]) await assert.rejects(confirmTokens(tokens), /Invalid token/);
assert.equal((await db.query("select confirmed_at from uploads where id=$1",[tokenDraft])).rows[0].confirmed_at,null);
await confirmTokens({ [tokenBill]: " 0012 ", [tokenSibling]: "A-013" });
await confirmTokens({ [tokenBill]: "changed on retry" });
const tokenSnapshot = (await db.query("select app_desk_snapshot($1) as data",[cashier])).rows[0].data;
assert.equal(tokenSnapshot.bills.find(b => b.id === tokenBill).token_number,"0012");
assert.equal(tokenSnapshot.bills.find(b => b.id === tokenSibling).token_number,"A-013");
assert.equal((await db.query("select detail from audit_events where bill_id=$1 and action='submitted'",[tokenBill])).rows[0].detail.token_number,"0012");
assert.equal((await db.query("select count(*) as n from audit_events where bill_id=$1 and action='submitted'",[tokenBill])).rows[0].n,1);
// A duplicate PDF rolls token changes back along with submission.
const duplicateTokenDraft = await draft("7".repeat(64));
const duplicateTokenBill = (await db.query("select id from bills where upload_id=$1",[duplicateTokenDraft])).rows[0].id;
await assert.rejects(confirmTokens({ [duplicateTokenBill]: "99" }, advisor, duplicateTokenDraft), /uploads_confirmed_hash_unique/);
assert.equal((await db.query("select token_number from bills where id=$1",[duplicateTokenBill])).rows[0].token_number,null);
await db.query("update bills set amount_paise=12500,invoice_date='2026-11-07' where id=$1",[tokenBill]);
const payWith = (method, actor = cashier) => db.query("select app_desk_action($1,'collect',$2,'',$3)",[actor,tokenBill,method]);
await assert.rejects(payWith("Cash",advisor),/Cashier/);
for (const method of [null,"","Unknown","Other: ","Other: " + "x".repeat(101)]) await assert.rejects(payWith(method),/payment method/);
await assert.rejects(db.query("select app_desk_action($1,'collect',$2,'')",[cashier,tokenBill]),/payment method/);
assert.equal((await db.query("select approval_status from bills where id=$1",[tokenBill])).rows[0].approval_status,"pending");
for (const method of ["Cash","GPay","Cheque","Demand Draft","Other: Bank transfer"]) {
 await Promise.all([payWith(method),payWith(method)]);
 const payment = (await db.query("select * from payments where bill_id=$1 and source='cashier' and not exists(select 1 from payments r where r.reversal_of=payments.id)",[tokenBill])).rows;
 assert.equal(payment.length,1);
 assert.equal(payment[0].method,method);
 await payWith("Cash"); // A retry must not replace the original method.
 assert.equal((await db.query("select method from payments where id=$1",[payment[0].id])).rows[0].method,method);
 await db.query("select app_desk_action($1,'reverse',$2,'Method test')",[admin,payment[0].id]);
 assert.equal((await db.query("select method from payments where reversal_of=$1",[payment[0].id])).rows[0].method,method);
}
assert.equal((await db.query("select detail from audit_events where bill_id=$1 and action='collect' and detail->>'payment_method'='Other: Bank transfer'",[tokenBill])).rows.length,1);
for (const role of ["anon","authenticated"]) {
 await db.exec("reset role; set role " + role);
 await assert.rejects(payWith("Cash"),/permission denied/);
 await assert.rejects(confirmTokens({}),/permission denied/);
 await assert.rejects(db.query("select desk_action('collect',$1,'','Cash')",[tokenBill]),/permission denied/);
}
console.log("Payment methods and tokens passed: validation, multi-bill submission, cashier visibility, atomic rollback, retries, all methods, reversals and role restrictions.");
// Admin-chosen passwords work immediately for every supported role.
await db.exec("reset role");
await db.exec(readFileSync("supabase/migrations/202611100001_admin_chosen_password.sql", "utf8"));
await db.exec("set role service_role");
for (const role of ["service_advisor", "cashier", "super_admin"]) {
 const id = (await db.query("select app_staff_account($1,'create_staff',null,$2,$3,'Chosen Password Staff',$4) as id",[admin,newHash,"chosen_"+role,role])).rows[0].id;
 const profile = (await db.query("select * from profiles where id=$1",[id])).rows[0];
 assert.equal(profile.role, role);
 assert.equal(profile.must_change_password, false);
 assert.equal((await db.query("select password_hash from staff_credentials where staff_id=$1",[id])).rows[0].password_hash,newHash);
 await db.query("select app_desk_snapshot($1)",[id]);
 await db.query("select app_staff_account($1,'reset_staff',$2,$3)",[admin,id,hash]);
 assert.equal((await db.query("select must_change_password from profiles where id=$1",[id])).rows[0].must_change_password,true);
}
await assert.rejects(db.query("select app_staff_account($1,'create_staff',null,$2,'forbidden','Forbidden','super_admin')",[cashier,newHash]),/Super admin/);
await assert.rejects(db.query("select app_staff_account($1,'create_staff',null,'plaintext','invalid_hash','Invalid','cashier')",[admin]),/check constraint/);
assert.equal((await db.query("select count(*) as n from profiles where staff_id='invalid_hash'")).rows[0].n,0);
console.log("Admin-chosen passwords passed: all roles, immediate access, hash validation, reset behavior and admin authorization.");
// Transaction references survive retries and reversals; account deletion is real.
await db.exec("reset role");
await db.exec(readFileSync("supabase/migrations/202611100002_transaction_id_and_delete_staff.sql", "utf8"));
await db.exec("set role service_role");
const payReference = reference => db.query("select app_desk_action($1,'collect',$2,'','GPay',$3)", [cashier, tokenBill, reference]);
await assert.rejects(payReference("x".repeat(101)), /Transaction ID/);
await payReference(" 00123-ABC ");
await payReference("replacement");
const referencePayment = (await db.query("select * from payments p where bill_id=$1 and source='cashier' and not exists(select 1 from payments r where r.reversal_of=p.id)", [tokenBill])).rows[0];
assert.equal(referencePayment.transaction_id, "00123-ABC");
assert.equal((await db.query("select app_desk_snapshot($1) as data", [admin])).rows[0].data.payments.find(p => p.id === referencePayment.id).transaction_id, "00123-ABC");
await db.query("select app_desk_action($1,'reverse',$2,'Reference test')", [admin, referencePayment.id]);
assert.equal((await db.query("select transaction_id from payments where reversal_of=$1", [referencePayment.id])).rows[0].transaction_id, "00123-ABC");
await payReference(null);
// Historical payments without references still reverse after the new requirement.
await db.exec("reset role");
await db.exec(readFileSync("supabase/migrations/202611100003_required_payment_references.sql", "utf8"));
await db.exec("set role service_role");
const legacyReferencePayment = (await db.query("select id from payments p where bill_id=$1 and source='cashier' and not exists(select 1 from payments r where r.reversal_of=p.id)", [tokenBill])).rows[0];
await db.query("select app_desk_action($1,'reverse',$2,'Legacy reference reversal')", [admin,legacyReferencePayment.id]);
const beforeMissingReference = (await db.query("select count(*) as n from payments")).rows[0].n;
for (const method of ["GPay", "Demand Draft", "Cheque"]) {
 for (const reference of [null, "", "   "]) {
  await assert.rejects(db.query("select app_desk_action($1,'collect',$2,'',$3,$4)", [cashier,tokenBill,method,reference]), /is required/);
 }
}
assert.equal((await db.query("select count(*) as n from payments")).rows[0].n,beforeMissingReference);
for (const method of ["GPay", "Demand Draft", "Cheque", "Cash", "Other: Bank transfer"]) {
 await db.query("select app_desk_action($1,'collect',$2,'',$3,$4)", [cashier,tokenBill,method," 001234 "]);
 const payment = (await db.query("select * from payments p where bill_id=$1 and source='cashier' and not exists(select 1 from payments r where r.reversal_of=p.id)", [tokenBill])).rows[0];
 assert.equal(payment.transaction_id, ["Cash", "Other: Bank transfer"].includes(method) ? null : "001234");
 await db.query("select app_desk_action($1,'reverse',$2,'Reference requirement test')", [admin,payment.id]);
}
console.log("Required references passed: missing/blank rejection, accepted GPay/DD/cheque references, Cash/Other discard references and legacy reversals remain valid.");
const paymentCount = (await db.query("select count(*) as n from payments")).rows[0].n;
const retainedBillCount = (await db.query("select count(*) as n from bills")).rows[0].n;
await db.query("update profiles set staff_id='admin01' where id=$1", [admin]);
const secondAdmin = (await db.query("select app_staff_account($1,'create_staff',null,$2,'delete_admin','Deletion test admin','super_admin') as id", [admin, newHash])).rows[0].id;
const deleteStaff = (actor, target) => db.query("select app_delete_staff($1,$2)", [actor,target]);
await assert.rejects(deleteStaff(cashier, advisor), /Super admin/);
await assert.rejects(deleteStaff(admin, admin), /cannot be deleted/);
await assert.rejects(deleteStaff(secondAdmin, admin), /cannot be deleted/);
await assert.rejects(deleteStaff(admin, randomUUID()), /not found/);
await db.query("insert into staff_sessions(token_hash,staff_id) values($1,$2)", ["d".repeat(64), cashier]);
await db.query("insert into staff_login_attempts(login_id) values('cashier') on conflict do nothing");
await deleteStaff(admin, cashier);
for (const table of ["profiles", "staff_credentials", "staff_sessions"]) {
 assert.equal((await db.query(`select count(*) as n from ${table} where ${table === "profiles" ? "id" : "staff_id"}=$1`, [cashier])).rows[0].n, 0);
}
assert.equal((await db.query("select count(*) as n from staff_login_attempts where login_id='cashier'")).rows[0].n,0);
assert.equal((await db.query("select count(*) as n from payments")).rows[0].n,paymentCount);
assert.equal((await db.query("select count(*) as n from bills")).rows[0].n,retainedBillCount);
assert.equal((await db.query("select recorded_by from payments where id=$1",[referencePayment.id])).rows[0].recorded_by,null);
await assert.rejects(db.query("select app_desk_snapshot($1)",[cashier]), /Active staff/);
await deleteStaff(admin, advisor);
assert.equal((await db.query("select uploaded_by from uploads where id=$1",[upload])).rows[0].uploaded_by,null);
assert.equal((await db.query("select count(*) as n from bills")).rows[0].n,retainedBillCount);
assert.equal((await db.query("select count(*) as n from audit_events where action='delete_staff'")).rows[0].n,2);
for (const role of ["anon", "authenticated"]) {
 await db.exec("reset role; set role " + role);
 await assert.rejects(deleteStaff(admin, secondAdmin), /permission denied/);
 await assert.rejects(payReference("forbidden"), /permission denied/);
}
console.log("Transaction IDs and deletion passed: references, retries, reversals, null references, authorization, protected admin01, credential/session removal and retained history.");
// Customer contacts and explicit skips share the atomic submission transaction.
await db.exec("reset role");
await db.exec(readFileSync("supabase/migrations/202611110001_whatsapp_sharing.sql", "utf8"));
const waAdvisor = otherAdvisor, waCashier = randomUUID();
await db.query("insert into profiles(id,staff_id,full_name,role,must_change_password) values($1,'wacashier','WA cashier','cashier',false)", [waCashier]);
const waDraft = await draft("8".repeat(64), waAdvisor);
const waBill = (await db.query("select id from bills where upload_id=$1", [waDraft])).rows[0].id;
const waSibling = randomUUID();
await db.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type) values($1,$2,$3,2,2,'test','reference')", [waSibling,waDraft,waAdvisor]);
const contacts = { [waBill]: { phone: "+919876543210", skipWhatsApp: false }, [waSibling]: { phone: null, skipWhatsApp: true } };
const waConfirm = (contact = contacts, tokens = {}, required = false, actor = waAdvisor, target = waDraft) => db.query("select to_jsonb(app_confirm_upload($1,$2,$3::jsonb,$4::jsonb,$5)) as upload", [actor,target,JSON.stringify(tokens),JSON.stringify(contact),required]);
const prepare = (target = waBill, actor = waAdvisor, phone = "+919876543211") => db.query("select app_prepare_whatsapp($1,$2,$3,now()+interval '7 days')", [actor,target,phone]);
await db.exec("set role service_role");
await assert.rejects(prepare(), /before sharing/);
await assert.rejects(waConfirm(contacts, {}, false, waCashier), /Service advisor/);
await assert.rejects(waConfirm(contacts, {}, false, secondAdmin), /Service advisor/);
for (const contact of [{}, [], { [waBill]: { phone: "bad", skipWhatsApp: false } }, { ...contacts, [waSibling]: {} }, { ...contacts, [waSibling]: { skipWhatsApp: "true" } }, { ...contacts, [singleStep]: { skipWhatsApp: true } }]) {
 await assert.rejects(waConfirm(contact), /WhatsApp|contact/);
}
await assert.rejects(waConfirm(contacts, { [waBill]: "0012" }, true), /Token number is required/);
assert.equal((await db.query("select customer_phone from bills where id=$1", [waBill])).rows[0].customer_phone, null, "Invalid sibling rolls back contact writes");
assert.equal((await db.query("select confirmed_at from uploads where id=$1", [waDraft])).rows[0].confirmed_at, null);
assert.equal((await db.query("select app_desk_snapshot($1) as data", [waCashier])).rows[0].data.bills.some(b => b.id === waBill), false);
const waResult = (await waConfirm(contacts, { [waBill]: "0012", [waSibling]: "A-013" }, true)).rows[0].upload;
assert.ok(waResult.confirmed_at);
assert.equal((await waConfirm(contacts)).rows[0].upload.confirmed_at, waResult.confirmed_at);
assert.equal((await db.query("select customer_phone,token_number from bills where id=$1", [waBill])).rows[0].customer_phone, "+919876543210");
assert.equal((await db.query("select token_number from bills where id=$1", [waBill])).rows[0].token_number, "0012");
assert.equal((await db.query("select count(*) as n from audit_events where bill_id=$1 and action='submitted'", [waBill])).rows[0].n, 1);
assert.equal((await db.query("select count(*) as n from audit_events where bill_id=$1 and action='whatsapp_skipped'", [waSibling])).rows[0].n, 1);
assert.equal((await db.query("select app_desk_snapshot($1) as data", [waCashier])).rows[0].data.bills.some(b => b.id === waBill), true, "Cashier sees the bill before WhatsApp preparation");
await assert.rejects(prepare(waBill, waCashier), /Service advisor/);
await assert.rejects(prepare(waBill, waAdvisor, "bad"), /Valid customer/);
await assert.rejects(prepare(tokenBill, waAdvisor), /not accessible/);
await prepare();
assert.equal((await db.query("select customer_phone from bills where id=$1", [waBill])).rows[0].customer_phone, "+919876543211");
assert.equal((await db.query("select count(*) as n from audit_events where bill_id=$1 and action='whatsapp_prepared'", [waBill])).rows[0].n, 1);
assert.equal((await db.query("select count(*) as n from audit_events where bill_id=$1 and action='submitted'", [waBill])).rows[0].n, 1);
const optionalDraft = await draft("9".repeat(64), waAdvisor);
const optionalBill = (await db.query("select id from bills where upload_id=$1", [optionalDraft])).rows[0].id;
await waConfirm({ [optionalBill]: { skipWhatsApp: true } }, {}, false, waAdvisor, optionalDraft);
for (const role of ["anon", "authenticated"]) {
 await db.exec("reset role; set role " + role);
 await assert.rejects(waConfirm(), /permission denied/);
 await assert.rejects(prepare(), /permission denied/);
}
await db.exec("reset role");
assert.equal((await db.query("select to_regprocedure('app_confirm_upload(uuid,uuid,jsonb)') as old")).rows[0].old, null);
console.log("WhatsApp migration passed: explicit choices, required tokens, atomic rollback, owner scope, cashier visibility before sharing, retries, phone correction and audit history.");
await db.exec(readFileSync("supabase/migrations/202611140001_customer_bill_links.sql", "utf8"));
const privatePath = `customer-copies/v1/${waDraft}/${"8".repeat(64)}/${waBill}-1-1.pdf`;
const mapping = (hash = "a".repeat(64), path = privatePath) => db.query(
 "insert into customer_bill_links(code_hash,bill_id,storage_path) values($1,$2,$3)", [hash,waBill,path]);
await db.exec("set role service_role");
await mapping();
const storedLink = (await db.query("select * from customer_bill_links")).rows[0];
assert.equal(new Date(storedLink.expires_at) - new Date(storedLink.created_at), 7 * 86400000);
assert.equal(storedLink.code_hash, "a".repeat(64));
await assert.rejects(mapping("raw-code"), /check constraint/);
await assert.rejects(mapping("b".repeat(64), "test.pdf"), /check constraint/);
await assert.rejects(mapping("b".repeat(64), "customer-copies/v1/../../test.pdf"), /check constraint/);
await assert.rejects(db.query("insert into customer_bill_links(code_hash,bill_id,storage_path) values($1,$2,$3),($4,$2,$3)",
 ["b".repeat(64),waBill,privatePath,"a".repeat(64)]), /duplicate key/);
assert.equal((await db.query("select count(*) as n from customer_bill_links")).rows[0].n, 1, "Group insertion is atomic");
for (const role of ["anon", "authenticated"]) {
 await db.exec("reset role; set role " + role);
 await assert.rejects(db.query("select * from customer_bill_links"), /permission denied/);
 await assert.rejects(mapping("b".repeat(64)), /permission denied/);
 await assert.rejects(db.query("update customer_bill_links set expires_at=now()+interval '1 year'"), /permission denied/);
 await assert.rejects(db.query("delete from customer_bill_links"), /permission denied/);
}
await db.exec("reset role");
assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.customer_bill_links'::regclass")).rows[0].relrowsecurity, true);
console.log("Customer bill links passed: server-only access, hash/path constraints, seven-day expiry and atomic group insertion.");
await (await import("./check-gate-passes-db.mjs")).checkGatePasses(db);
await db.exec("reset role");
await db.exec(readFileSync("supabase/migrations/202611140003_bill_attachments.sql", "utf8"));
const prepareAttachment = (actor = waAdvisor, target = waBill, phone = "+919876543211") => db.query("select app_prepare_whatsapp($1,$2,$3,null)", [actor,target,phone]);
await db.exec("set role service_role");
await prepareAttachment();
const attachmentAudit = (await db.query("select detail from audit_events where bill_id=$1 and action='whatsapp_prepared' and detail->>'mode'='attachment'", [waBill])).rows;
assert.equal(attachmentAudit.length, 1);
assert.equal(attachmentAudit[0].detail.expires_at, undefined);
assert.equal(attachmentAudit[0].detail.phone_last_four, "3211");
await prepare(); // Legacy callers still supply a future expiry.
await assert.rejects(prepareAttachment(waCashier), /Service advisor/);
await assert.rejects(prepareAttachment(waAdvisor, tokenBill), /not accessible/);
await assert.rejects(prepareAttachment(waAdvisor, waBill, "bad"), /Valid customer/);
for (const role of ["anon", "authenticated"]) {
 await db.exec("reset role; set role " + role);
 await assert.rejects(prepareAttachment(), /permission denied/);
}
await db.exec("reset role");
console.log("Attachment audit passed: private role/owner validation, no fictional expiry, and backward-compatible link preparation.");
await db.close();
console.log("All migrations passed: bill history, financial workflow, app credentials, role boundaries, session revocation, rate limiting and legacy Auth denial.");
