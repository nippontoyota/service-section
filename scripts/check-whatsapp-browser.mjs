// Build with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3120.
// Regression: advisors submit without customer sharing; legacy sharing routes are retired.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH + '/index.mjs' : 'playwright');
const base='http://127.0.0.1:3119', backend='http://127.0.0.1:3120';
const profile={id:randomUUID(),staff_id:'advisor_test',full_name:'Test Advisor',role:'service_advisor',active:true,must_change_password:false};
const session='a'.repeat(43), hash=createHash('sha256').update(session).digest('hex');
const bills=[], uploads=[], audit=[], confirmationBodies=[];
let confirms=0, failConfirm=null, failLookup=false;
function draft(name) {
 const upload={id:randomUUID(),original_filename:name+'.pdf',storage_path:'test.pdf',confirmed_at:null,file_hash:createHash('sha256').update(name).digest('hex'),status:'review'};
 const bill={id:randomUUID(),upload_id:upload.id,uploaded_by:profile.id,customer_id:randomUUID(),customer_name:name,customer_reference:name,customer_phone:'+919876543210',token_number:null,invoice_reference:'INV-'+name,vehicle_no_display:'KL01AB1234',vin:'',invoice_date:'2026-11-14',amount_paise:10000,approval_status:'pending',created_at:new Date().toISOString(),page_from:1,page_to:1,amount_evidence:'Total 100',extraction_issues:[],payment_evidence:[],uploads:upload};
 uploads.push(upload); bills.push(bill); return bill;
}
const alpha=draft('ALPHA'), sibling=draft('ALPHA-SECOND'), bravo=draft('BRAVO');
sibling.customer_id=alpha.customer_id;sibling.customer_name=alpha.customer_name;sibling.customer_reference=alpha.customer_reference;
const snapshot=()=>({bills,drafts:uploads.filter(u=>!u.confirmed_at).map(u=>({...u,bills:bills.filter(b=>b.upload_id===u.id)})),staff:[profile],payments:[],audit,as_of:new Date().toISOString()});
const json=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const server=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,backend), path=url.pathname;
  if(path==='/rest/v1/staff_sessions')return json(res,url.searchParams.get('token_hash')==='eq.'+hash?{staff_id:profile.id,profiles:profile}:null);
  if(path==='/rest/v1/rpc/app_desk_snapshot')return json(res,snapshot());
  if(path==='/rest/v1/uploads')return json(res,snapshot().drafts);
  if(path==='/rest/v1/bills'){
   if(failLookup)return json(res,{message:'Synthetic lookup failure'},503);
   if(url.searchParams.has('upload_id'))return json(res,bills.filter(b=>'eq.'+b.upload_id===url.searchParams.get('upload_id')&&'eq.'+b.uploaded_by===url.searchParams.get('uploaded_by')).map(b=>({id:b.id})));
   return json(res,null);
  }
  if(path==='/rest/v1/rpc/app_confirm_upload'){
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   confirmationBodies.push(body);
   assert.equal(body.staff,profile.id);assert.equal(body.require_token,true);
   const upload=uploads.find(u=>u.id===body.target);
   if(!upload)return json(res,{code:'P0002',message:'Upload not found'},400);
   if(upload.confirmed_at)return json(res,upload);
   if(upload.id===failConfirm)return json(res,{code:'55000',message:'Synthetic submission failure'},400);
   const selected=bills.filter(b=>b.upload_id===upload.id);
   assert.deepEqual(Object.keys(body.contacts).sort(),selected.map(b=>b.id).sort());
   for(const b of selected){
    assert.deepEqual(body.contacts[b.id],{phone:null,skipWhatsApp:true},'Server must ignore legacy advisor phone choices');
    if(!(body.tokens[b.id]??b.token_number))return json(res,{code:'22023',message:'Token number is required for every bill at this branch'},400);
   }
   for(const b of selected){b.token_number=body.tokens[b.id]??b.token_number;b.customer_phone=null;}
   confirms++;upload.confirmed_at=new Date().toISOString();upload.status='confirmed';return json(res,upload);
  }
  throw new Error('Unexpected backend request: '+path);
 }catch(error){console.error(error);json(res,{message:error.message},500);}
});
await new Promise(resolve=>server.listen(3120,'127.0.0.1',resolve));
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--port','3119','--hostname','127.0.0.1'],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:backend,SUPABASE_SERVICE_ROLE_KEY:'isolated-test-key',SERVICE_DESK_DEMO:'false',BILLDESK_REQUIRE_TOKEN:'true'},stdio:['ignore','pipe','pipe']});
let logs='', browser;app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b);
const post=(path,body,cookie=session)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:'billdesk_session='+cookie},body:JSON.stringify(body)});
try {
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 const confirm='/api/uploads/'+alpha.upload_id+'/confirm';
 assert.equal((await post(confirm,{tokens:{}},'invalid')).status,401);
 profile.role='cashier';assert.equal((await post(confirm,{tokens:{}})).status,403);profile.role='service_advisor';
 assert.equal((await post(confirm,{tokens:[]})).status,400);
 assert.equal((await post(confirm,{tokens:{}})).status,400,'Required tokens still enforced');
 failLookup=true;assert.equal((await post(confirm,{tokens:{[alpha.id]:'1'}})).status,503);failLookup=false;
 assert.equal(confirms,0);
 for(const method of ['POST','GET']){
  const path='/api/bills/'+alpha.id+(method==='POST'?'/whatsapp':'/attachment');
  const response=method==='POST'?await post(path,{customerPhone:'9876543210'}):await fetch(base+path);
  assert.equal(response.status,410);assert.match((await response.json()).error,/no longer available/);
 }
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'billdesk_session',value:session,url:base}]);
 await context.addInitScript(id=>{sessionStorage.setItem('desk-sharing-batch:'+id,'["old-bill"]');sessionStorage.setItem('desk-shared-batches:'+id,'[["old-bill"]]');},profile.id);
 const page=await context.newPage(), errors=[], shares=[];page.on('pageerror',error=>errors.push(error.message));
 page.on('request',req=>{if(/wa\.me|api\/bills\/.*\/(whatsapp|attachment)/.test(req.url()))shares.push(req.url());});
 const click=name=>page.getByRole('button',{name,exact:true}).click();
 const settled=()=>page.waitForFunction(()=>!document.querySelector('.sd-operation[open], .sd-operation-inline'));
 await page.goto(base);await click('Upload bills (3)');
 const review=page.getByRole('dialog',{name:'Upload and review bills'});
 assert.equal(await review.getByLabel('Customer WhatsApp number').count(),0);
 assert.doesNotMatch(await review.innerText(),/WhatsApp|Prepare PDFs|Share PDFs|Copy message/);
 assert.equal(await page.evaluate(id=>sessionStorage.getItem('desk-sharing-batch:'+id),profile.id),null);
 await click('Submit all to cashier');
 await review.getByText('Token number is required for every bill at this branch',{exact:true}).waitFor();assert.equal(confirms,0);
 for(let i=0;i<3;i++)await review.getByLabel('Token number (required)').nth(i).fill('T-'+i);
 await review.getByRole('button',{name:'View bill',exact:true}).first().click();
 assert.equal(await page.getByRole('dialog',{name:'Bill INV-ALPHA',exact:true}).getByLabel('Customer WhatsApp number').count(),0);
 await click('Close bill details');
 failConfirm=bravo.upload_id;
 await click('Submit all to cashier');
 await page.getByRole('dialog',{name:'Some bills were not submitted',exact:true}).waitFor();await click('Continue');
 assert.equal(confirms,2);assert.equal(await page.locator('.sd-queue-item').count(),1);
 await page.reload();await click('Upload bills (1)');
 await review.getByLabel('Token number (required)').fill('T-2');failConfirm=null;
 await click('Submit to cashier');await review.waitFor({state:'hidden'});await settled();
 assert.equal(confirms,3);assert(bills.every(b=>b.customer_phone===null));
 assert.equal(await page.locator('.sd-sharing-queue').count(),0);assert.deepEqual(shares,[]);
 await click('INV-ALPHA');assert.equal(await page.getByLabel('Customer WhatsApp number').count(),0);await click('Close bill details');
 // An older client cannot re-enable advisor bill delivery via its contacts payload.
 const legacy=draft('LEGACY');
 assert.equal((await post('/api/uploads/'+legacy.upload_id+'/confirm',{tokens:{[legacy.id]:'OLD'},contacts:{[legacy.id]:{phone:'+919876543210',skipWhatsApp:false}}})).status,200);
 assert.equal(legacy.customer_phone,null);
 // Lost confirmation responses reconcile via refresh, without a sharing queue or resubmission.
 const timeout=draft('TIMEOUT');timeout.token_number='TIME';await click('Refresh');await settled();await click('Upload bills (1)');
 await page.clock.install();let committed=false;const before=confirms;
 await page.route('**/api/uploads/'+timeout.upload_id+'/confirm',async route=>{await route.fetch();committed=true;});
 await click('Submit to cashier');
 await review.locator('.sd-operation-inline').waitFor();assert.equal(await page.locator('.sd-operation[open]').count(),0);
 for(let i=0;i<100&&!committed;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(committed,true);
 await page.clock.fastForward(120100);await page.getByRole('dialog',{name:'Some bills were not submitted',exact:true}).waitFor();await click('Continue');
 assert.equal(await review.getByRole('button',{name:'Submit to cashier',exact:true}).isDisabled(),true);
 await review.getByRole('button',{name:'Refresh status',exact:true}).click();await settled();
 assert.equal(await page.locator('.sd-queue-item').count(),0);assert.equal(confirms,before+1);
 await click('Close upload dialog');assert.deepEqual(shares,[]);
 for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 assert.deepEqual(errors,[]);
 console.log('Advisor flow passed: no customer phone/sharing UI, token-only submissions, server ignores legacy contacts, retired endpoints, partial/reload recovery, timeout reconciliation, no duplicate writes and responsive layout.');
}catch(error){console.error(logs);throw error;}
finally{await browser?.close();app.kill();await new Promise(resolve=>server.close(resolve));}
