// Real, independent PostgreSQL sessions. Creates a uniquely named disposable local database.
// PG_TEST_URL must point to a local maintenance database; PG_TEST_DRIVER optionally names pg's package path.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
const url=new URL(process.env.PG_TEST_URL||'');
assert(['localhost','127.0.0.1'].includes(url.hostname),'Concurrency checks require a disposable local PostgreSQL cluster');
const {default:pg}=await import(process.env.PG_TEST_DRIVER?process.env.PG_TEST_DRIVER+'/lib/index.js':'pg');
const admin=new pg.Client({connectionString:url.href});await admin.connect();
const name='billdesk_gate_test_'+randomUUID().replaceAll('-','');
await admin.query('create database '+name);
url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.href,max:6});
const a=await pool.connect(), b=await pool.connect();
try{
 await a.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if; end $$;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;
 create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
 create publication supabase_realtime;`);
 for(const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await a.query(readFileSync('supabase/migrations/'+file,'utf8'));
 const cashier=randomUUID(),guard=randomUUID(),advisor=randomUUID(),manager=randomUUID();
 for(const [id,role]of[[cashier,'cashier'],[guard,'security'],[advisor,'service_advisor'],[manager,'super_admin']])await a.query('insert into profiles(id,staff_id,full_name,role,must_change_password) values($1,$2,$2,$2,false)',[id,role]);
 const first=randomUUID(),upload=randomUUID();
 await a.query("insert into uploads(id,uploaded_by,storage_path,original_filename,status,confirmed_at) values($1,$2,'test.pdf','test.pdf','confirmed',now())",[upload,advisor]);
 const addBill=(id,u)=>a.query("insert into bills(id,upload_id,uploaded_by,page_from,page_to,connection_key,connection_key_type,customer_name,customer_reference,vehicle_no_display,invoice_reference,invoice_date,amount_paise) values($1,$2,$3,1,1,$1::uuid::text,'vehicle','Synthetic Customer','CONCURRENCY','KL01AB1234',$1::uuid::text,current_date,10000)",[id,u,advisor]);
 await addBill(first,upload);
 const pay=id=>a.query("select app_desk_action($1,'collect',$2,'','Cash',null)",[cashier,id]);await pay(first);
 const issue=(client=a)=>client.query("select app_issue_gate_pass($1,$2,'+919876543210',$3,$4) result",[cashier,first,randomUUID(),randomUUID().replaceAll('-','').repeat(2)]).then(r=>r.rows[0].result);
 const hash=async pass=>(await a.query('select code_hash from gate_passes where id=$1',[pass.id])).rows[0].code_hash;
 const confirm=(client,code)=>client.query('select app_check_gate_pass($1,$2,true) result',[guard,code]).then(r=>r.rows[0].result);
 let [one,two]=await Promise.all([issue(a),issue(b)]);assert.equal(one.id,two.id);assert.equal(one.expiresAt,two.expiresAt);
 let code=await hash(one);const results=await Promise.all([confirm(a,code),confirm(b,code)]);assert.equal(results.filter(r=>r.confirmed).length,1);
 // Use a fresh visit for the write/confirmation races.
 const next=randomUUID();await addBill(next,upload);await pay(next);
 const issueNext=()=>a.query("select app_issue_gate_pass($1,$2,'+919876543210',$3,$4) result",[cashier,next,randomUUID(),randomUUID().replaceAll('-','').repeat(2)]).then(r=>r.rows[0].result);
 one=await issueNext();code=await hash(one);
 const payment=(await a.query("select id from payments where bill_id=$1 and source='cashier'",[next])).rows[0].id;
 await a.query('begin');await a.query("select app_desk_action($1,'reverse',$2,'test correction','',null)",[manager,payment]);
 let finished=false;let waiting=confirm(b,code).then(r=>{finished=true;return r;});
 await new Promise(r=>setTimeout(r,100));assert.equal(finished,false,'confirmation waits for reversal commit');
 await a.query('commit');assert.equal((await waiting).status,'Revoked');
 await pay(next);one=await issueNext();code=await hash(one);
 const draft=randomUUID(),newBill=randomUUID();await a.query("insert into uploads(id,uploaded_by,storage_path,original_filename,status,file_hash) values($1,$2,'draft.pdf','draft.pdf','review',$3)",[draft,advisor,'1'.repeat(64)]);await addBill(newBill,draft);
 await a.query('begin');await a.query("select app_confirm_upload($1,$2,'{}'::jsonb,$3::jsonb,false)",[advisor,draft,JSON.stringify({[newBill]:{skipWhatsApp:true}})]);
 finished=false;waiting=confirm(b,code).then(r=>{finished=true;return r;});await new Promise(r=>setTimeout(r,100));assert.equal(finished,false,'confirmation waits for submission commit');
 await a.query('commit');assert.equal((await waiting).status,'Payment not cleared');
 await pay(newBill);one=await issueNext();code=await hash(one);
 await a.query('begin');assert.equal((await confirm(a,code)).confirmed,true);
 finished=false;waiting=b.query("select app_issue_gate_pass($1,$2,'+919876543210',$3,$4) result",[cashier,next,randomUUID(),'2'.repeat(64)]).then(r=>{finished=true;return r.rows[0].result;});
 await new Promise(r=>setTimeout(r,100));assert.equal(finished,false,'issuance waits for completed exit');await a.query('commit');assert.match((await waiting).error,/completed exit/);
 // Batch collection retries and approval revocation use the same lock as gate exits.
 const batchBill1=randomUUID(),batchBill2=randomUUID();await addBill(batchBill1,upload);await addBill(batchBill2,upload);
 const batchId=randomUUID();const batchPayload={action:'collect_batch',payer:'customer',method:'Cash',entries:[{billId:batchBill1,amountPaise:10000},{billId:batchBill2,amountPaise:10000}],details:{}};
 const collectBatch=(client,id=batchId)=>client.query('select app_settle_bills($1,$2,$3)',[cashier,id,JSON.stringify(batchPayload)]);
 await Promise.all([collectBatch(a),collectBatch(b)]);
 assert.equal((await a.query('select count(*)::int n from payments where collection_id=$1',[batchId])).rows[0].n,2,'retry cannot double-collect either invoice');
 await assert.rejects(collectBatch(b,randomUUID()),/exceeds/);
 const creditBill=randomUUID();await addBill(creditBill,upload);const creditId=randomUUID();
 await a.query('select app_settle_bills($1,$2,$3)',[cashier,creditId,JSON.stringify({action:'arrange',kind:'credit',payer:'customer',entries:[{billId:creditBill,amountPaise:0}],details:{approvedBy:'Manager',approvedOn:'2026-11-20',dueDate:'2026-12-20'}})]);
 const creditPass=(await a.query("select app_issue_gate_pass($1,$2,'+919876543210',$3,$4) result",[cashier,creditBill,randomUUID(),'3'.repeat(64)])).rows[0].result;
 code=await hash(creditPass);
 await a.query('begin');await a.query('select app_settle_bills($1,$2,$3)',[manager,randomUUID(),JSON.stringify({action:'revoke_settlement',settlementId:creditId,details:{remarks:'Credit approval correction'}})]);
 finished=false;waiting=confirm(b,code).then(r=>{finished=true;return r;});await new Promise(r=>setTimeout(r,100));assert.equal(finished,false,'confirmation waits for credit revocation');
 await a.query('commit');assert.equal((await waiting).status,'Revoked');
 console.log('Real PostgreSQL concurrency passed: simultaneous issuance returns one pass; simultaneous confirmation records one exit; reversal/submission commits block confirmation; completed exit blocks reissuance; batch retries collect once; credit revocation blocks exit.');
}finally{
 await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});a.release();b.release();await pool.end();await admin.query('drop database '+name);await admin.end();
}
