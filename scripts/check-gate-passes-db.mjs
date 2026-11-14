import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
export async function checkGatePasses(db) {
 await db.exec(readFileSync("supabase/migrations/202611140002_gate_passes.sql", "utf8"));
 const ids = Object.fromEntries(["advisor", "advisor2", "cashier", "guard", "admin"].map(x => [x, randomUUID()]));
 for (const [key, id] of Object.entries(ids)) await db.query("insert into profiles(id,staff_id,full_name,role,must_change_password) values($1,$2,$2,$3,false)", [id,"gate_"+key, key.startsWith("advisor") ? "service_advisor" : key === "guard" ? "security" : key === "admin" ? "super_admin" : key]);
 let n = 0;
 async function bill({ vehicle = "KL 01 AB 1234", customer = "GATE-CUSTOMER", amount = 10000, kind, advisor = ids.advisor, submitted = true, name = "Gate Customer" } = {}) {
  const upload = randomUUID(), id = randomUUID();
  await db.query("insert into uploads(id,uploaded_by,storage_path,original_filename,status,confirmed_at,file_hash) values($1,$2,$3,'gate.pdf',$4,$5,$6)", [upload,advisor,id+'.pdf',submitted?'confirmed':'review',submitted?new Date().toISOString():null,(++n).toString(16).padStart(64,'f')]);
  await db.query(`insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,customer_name,customer_reference,vehicle_no_display,invoice_reference,invoice_date,amount_paise,field_confidence,amount_evidence)
  values($1,$2,$3,1,1,$1::uuid::text,'vehicle',$4,$5,$6,$1::uuid::text,'2026-11-14',$7,$8::jsonb,$9)`, [id,upload,advisor,name,customer,vehicle,amount,JSON.stringify(kind?{document:{kind}}:{}),kind?'No monetary total stated; supporting note':'Total']);
  return id;
 }
 const pay = id => db.query("select app_desk_action($1,'collect',$2,'','Cash',null)",[ids.cashier,id]);
 const issue = async (target, actor=ids.cashier) => (await db.query("select app_issue_gate_pass($1,$2,'+919876543210',$3,$4) as result", [actor,target,randomUUID(),randomUUID().replaceAll('-','').repeat(2)])).rows[0].result;
 const hash = async id => (await db.query("select code_hash from gate_passes where id=$1",[id])).rows[0].code_hash;
 const check = async (id, confirm=false, actor=ids.guard) => (await db.query("select app_check_gate_pass($1,$2,$3) as result",[actor,await hash(id),confirm])).rows[0].result;
 for (const kind of ['warranty_note','amc_note']) {
  const note=await bill({customer:kind,amount:null,kind});
  const before=(await db.query('select count(*)::int n from payments')).rows[0].n;
  const notePass=await issue(note); assert.equal(notePass.status,'Valid');
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,before);
  assert.equal((await issue(note)).id,notePass.id);
  assert.equal((await check(notePass.id,true)).confirmed,true);
  assert.equal((await check(notePass.id,true)).status,'Already used');
 }
 const draftNote=await bill({customer:'DRAFT-NOTE',amount:null,kind:'warranty_note',submitted:false});
 await assert.rejects(issue(draftNote),/submitted bill required/);
 for (const details of [{customer:'NOTE-NO-VEHICLE',vehicle:''},{customer:'NOTE-NO-NAME',name:''}]) {
  await assert.rejects(issue(await bill({...details,amount:null,kind:'amc_note'})),/Identified/);
 }
 const first=await bill(), cross=await bill({advisor:ids.advisor2,vehicle:"kl-01-ab-1234"});
 const otherVehicle=await bill({vehicle:"KL01ZZ9999"});
 const note=await bill({amount:null,kind:"warranty_note"});
 await pay(first);
 let blocked=await issue(first); assert.equal(blocked.blockers.length,1); assert.equal(blocked.blockers[0].id,cross);
 assert.equal((await issue(note)).blockers[0].id,cross);
 await pay(cross);
 const unread=await bill({amount:null}); assert.equal((await issue(first)).blockers[0].id,unread);
 assert.equal((await issue(note)).blockers[0].id,unread);
 await db.query("update bills set amount_paise=5000 where id=$1",[unread]); await pay(unread);
 const pass=await issue(first); assert.equal(pass.status,"Valid"); assert.equal((await issue(first)).id,pass.id);
 assert.equal((await issue(note)).id,pass.id);
 assert.equal((await issue(first)).expiresAt,pass.expiresAt);
 assert.equal((await db.query("select count(*)::int n from gate_pass_bills where pass_id=$1",[pass.id])).rows[0].n,4);
 assert.equal((await check(pass.id)).status,"Valid");
 const publicPass=(await db.query("select app_public_gate_pass($1) result",[await hash(pass.id)])).rows[0].result;
 assert.equal(publicPass.issuer,undefined); assert.equal(publicPass.amount_paise,undefined);
 assert.equal((await db.query("select app_public_gate_pass($1) result",['0'.repeat(64)])).rows[0].result.status,"Invalid");
 await assert.rejects(issue(first,ids.guard),/Cashier/);
 await assert.rejects(check(pass.id,false,ids.cashier),/Security/);
 await assert.rejects(db.query("select app_desk_snapshot($1)",[ids.guard]),/not accessible/);
 await assert.rejects(db.query("select app_desk_action($1,'collect',$2,'','Cash',null)",[ids.guard,otherVehicle]),/Cashier/);
 await assert.rejects(db.query("select app_staff_account($1,'create_staff',null,null,'bad','Bad','cashier')",[ids.guard]),/Super admin/);
 const missing=await bill({customer:"MISSING",vehicle:""}); await pay(missing); await assert.rejects(issue(missing),/Identified/);
 const nameless=await bill({customer:"NAMELESS",name:""}); await pay(nameless); await assert.rejects(issue(nameless),/Identified/);
 await assert.rejects(db.query("select app_issue_gate_pass($1,$2,null,$3,$4)",[ids.cashier,first,randomUUID(),'1'.repeat(64)]),/WhatsApp/);
 const later=await bill(); assert.equal((await check(pass.id)).status,"Payment not cleared");
 assert.equal((await check(pass.id,true)).status,"Payment not cleared"); await pay(later);
 assert.equal((await check(pass.id)).status,"Payment not cleared",'New paid bills require replacement too');
 const replacement=await issue(first); assert.notEqual(replacement.id,pass.id); assert.equal((await check(pass.id)).status,"Revoked");
 const payment=(await db.query("select id from payments where bill_id=$1 and source='cashier'",[later])).rows[0].id;
 await db.query("select app_desk_action($1,'reverse',$2,'test correction','',null)",[ids.admin,payment]);
 assert.equal((await check(replacement.id)).status,"Revoked"); assert.ok((await issue(first)).error);
 await pay(later); const renewed=await issue(first);
 await db.query("update gate_passes set issued_at=now()-interval '25 hours', expires_at=now()-interval '1 hour' where id=$1",[renewed.id]);
 assert.equal((await check(renewed.id)).status,"Expired"); assert.equal((await check(renewed.id,true)).status,"Expired");
 const active=await issue(first); assert.notEqual(active.id,renewed.id);
 const exit=await check(active.id,true); assert.equal(exit.confirmed,true);
 assert.equal((await check(active.id,true)).status,"Already used"); assert.equal((await check(active.id,true)).confirmed,undefined);
 assert.ok((await issue(first)).error);
 const nextVisit=await bill(); await pay(nextVisit); const nextPass=await issue(nextVisit); assert.equal(nextPass.status,"Valid");
 assert.equal((await db.query("select count(*)::int n from gate_pass_bills where pass_id=$1",[nextPass.id])).rows[0].n,1);
 await db.query("select app_delete_staff($1,$2)",[ids.admin,ids.guard]);
 const history=(await db.query("select guard_id,guard_name from gate_passes where id=$1",[active.id])).rows[0];
 assert.equal(history.guard_id,null); assert.equal(history.guard_name,"gate_guard");
 await db.query("select app_delete_staff($1,$2)",[ids.admin,ids.cashier]);
 assert.equal((await db.query("select issuer_name from gate_passes where id=$1",[active.id])).rows[0].issuer_name,"gate_cashier");
 assert.equal((await db.query("select app_public_gate_pass($1) result",[await hash(nextPass.id)])).rows[0].result.status,"Valid", "Deleting a cashier preserves active passes and payment clearance");
 for (const role of ['anon','authenticated']) {
  await db.exec('set role '+role);
  for (const table of ['gate_passes','gate_pass_bills']) await assert.rejects(db.query('select * from '+table),/permission denied/);
  await assert.rejects(db.query("select app_public_gate_pass($1)",['0'.repeat(64)]),/permission denied/);
  await assert.rejects(issue(first),/permission denied/);
  await assert.rejects(db.query("select app_check_gate_pass($1,$2,true)",[ids.guard,'0'.repeat(64)]),/permission denied/);
  await db.exec('reset role');
 }
 // Verify every old writer acquires the lock before row locks, and direct writes use BEFORE STATEMENT triggers.
 for (const sig of ['desk_action(text,uuid,text,text,text)','app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean)']) {
  const source=(await db.query("select pg_get_functiondef($1::regprocedure) s",[sig])).rows[0].s;
  assert.ok(source.indexOf('PERFORM public.gate_lock()') < source.toLowerCase().indexOf('for update'));
 }
 assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname in ('gate_lock_bills','gate_lock_payments','gate_lock_uploads') and tgtype=30")).rows[0].n,3);
 console.log('Gate passes passed: cross-advisor clearance, vehicle scope, unread totals, notes, retries, resends, expiry, replacement, reversal, new visits, one exit, role denial and retained audit names.');
}
