// Build first with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3120.
// Isolated API/browser integration. Uses synthetic data and intercepts WhatsApp; no messages sent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH+'/index.mjs' : 'playwright');
const base='http://127.0.0.1:3131', backend='http://127.0.0.1:3120';
const secret='isolated-gate-secret-'.repeat(3), cashier={id:randomUUID(),staff_id:'cashier_test',full_name:'Test Cashier',role:'cashier',active:true,must_change_password:false};
const guard={...cashier,id:randomUUID(),staff_id:'guard_test',full_name:'Test Guard',role:'security'};
const bill={id:randomUUID(),upload_id:randomUUID(),customer_id:randomUUID(),customer_name:'Synthetic Customer',customer_phone:'+919876543210',customer_reference:'TEST',vehicle_no_display:'KL01AB1234',vin:'',invoice_reference:'GATE-TEST',invoice_date:'2026-11-14',amount_paise:10000,approval_status:'pending',created_at:new Date().toISOString(),page_from:1,page_to:1,extraction_issues:[],amount_evidence:'Total 100',payment_evidence:[],uploads:{confirmed_at:new Date().toISOString(),original_filename:'synthetic.pdf'}};
const notes=['warranty_note','amc_note'].map(kind=>({...bill,id:randomUUID(),upload_id:randomUUID(),invoice_reference:kind,amount_paise:null,amount_evidence:'No monetary total stated; supporting note',field_confidence:{document:{kind}}}));
const unread={...bill,id:randomUUID(),invoice_reference:'UNREAD-TOTAL',amount_paise:null};
const draft={...notes[0],id:randomUUID(),invoice_reference:'DRAFT-NOTE',uploads:{...bill.uploads,confirmed_at:null}};
let bills=[...notes,unread,draft];
const payments=[], calls=[];
let pass=null, storedHash='', fail=false, blockers=false, confirms=0;
const tokens={cashier:'a'.repeat(43),guard:'b'.repeat(43)};
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,backend);let raw='';for await(const chunk of req) raw+=chunk;const body=raw?JSON.parse(raw):{};
 if(url.pathname==='/rest/v1/staff_sessions'){
  const hash=url.searchParams.get('token_hash');const profile=hash==='eq.'+sha(tokens.cashier)?cashier:hash==='eq.'+sha(tokens.guard)?guard:null;
  return json(res,profile?{staff_id:profile.id,profiles:profile}:null);
 }
 calls.push(url.pathname);
 if(url.pathname==='/rest/v1/rpc/app_desk_snapshot'){assert.equal(body.staff,cashier.id);return json(res,{bills,payments,staff:[cashier],audit:[],as_of:new Date().toISOString()});}
 if(url.pathname==='/rest/v1/rpc/app_desk_action'){assert.equal(body.staff,cashier.id);assert.equal(body.action,'collect');bill.approval_status='approved';payments.push({id:randomUUID(),bill_id:bill.id,amount_paise:10000,method:'Cash',occurred_at:new Date().toISOString(),recorded_by:cashier.id,source:'cashier'});return json(res,null);}
 if(url.pathname==='/rest/v1/rpc/app_issue_gate_pass'){
  assert.equal(body.staff,cashier.id);assert.equal(body.phone,'+919876543210');
  assert.ok(bills.some(b=>b.id===body.target&&b.uploads.confirmed_at));
  if(blockers)return json(res,{error:'Payment not cleared.',blockers:[{reference:blockers}]});
  if(fail)return json(res,{message:'Database unavailable'},503);
  if(!pass){storedHash=body.pass_hash;pass={id:body.pass_id,status:'Valid',customerName:'Synthetic Customer',vehicle:'KL01AB1234',issuer:'Test Cashier',expiresAt:new Date(Date.now()+86400000).toISOString()};}
  return json(res,pass);
 }
 if(url.pathname==='/rest/v1/rpc/app_public_gate_pass'||url.pathname==='/rest/v1/rpc/app_check_gate_pass'){
  if(fail)return json(res,{message:'Database unavailable'},503);
  if(body.pass_hash!==storedHash)return json(res,{status:'Invalid'});
  if(url.pathname.endsWith('app_public_gate_pass')){const {issuer,...publicPass}=pass;void issuer;return json(res,publicPass);}
  assert.equal(body.staff,guard.id);
  if(body.confirm_exit&&pass.status==='Valid'){confirms++;pass={...pass,status:'Already used',exitAt:new Date().toISOString()};return json(res,{...pass,confirmed:true});}
  return json(res,pass);
 }
 if(url.pathname==='/rest/v1/bills')return json(res,{message:'No PDF in this synthetic test'},404);
 return json(res,{message:'Unexpected backend route '+url.pathname},404);
});
await new Promise(resolve=>server.listen(3120,'127.0.0.1',resolve));
let log='';const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3131'],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:backend,SUPABASE_SERVICE_ROLE_KEY:'isolated-test-key',BILLDESK_PUBLIC_URL:base,GATE_PASS_SIGNING_SECRET:secret,SERVICE_DESK_DEMO:'false'},stdio:['ignore','pipe','pipe']});
app.stdout.on('data',c=>log+=c);app.stderr.on('data',c=>log+=c);
let browser;
const post=(path,body,role='guard')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:'billdesk_session='+tokens[role]},body:JSON.stringify(body)});
try{
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.addCookies([{name:'billdesk_session',value:tokens.cashier,url:base}]);
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.open=()=>null;});
 await page.addLocatorHandler(page.locator('.sd-operation[data-outcome="failure"][open]'), async dialog => {
  assert.equal(await dialog.locator('.sd-operation-tick').count(),0);
  await dialog.getByRole('button',{name:'Continue'}).click();
 });
 await page.goto(base);
 await page.getByRole('button',{name:'UNREAD-TOTAL',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Issue gate pass',exact:true}).count(),0);
 await page.getByRole('button',{name:'Close bill details'}).click();
 assert.equal(await page.getByRole('button',{name:'warranty_note',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'amc_note',exact:true}).count(),0);
 // A visit containing only no-collection notes can issue from Archive without collection.
 bills=notes;await page.reload();
 await page.getByRole('button',{name:/^Archive/}).click();
 for(const note of notes){
  await page.getByRole('button',{name:note.invoice_reference,exact:true}).click();
  const dialog=page.getByRole('dialog', {name:/^Bill /});
  assert.match(await dialog.innerText(),/No collection required/);
  assert.doesNotMatch(await dialog.innerText(),/An invoice alone does not confirm payment/);
  assert.equal(await page.getByLabel('Mode of payment').count(),0);
  assert.equal(await page.getByRole('button',{name:/Mark as paid/}).count(),0);
  assert.equal(await page.getByLabel('Customer WhatsApp number').inputValue(),'+919876543210');
  await page.getByRole('button',{name:'Issue gate pass',exact:true}).click();
  await page.getByRole('link',{name:'Open gate pass in WhatsApp'}).waitFor();
  for(const reference of ['UNPAID-OTHER-ADVISOR','UNREAD-TOTAL']){
   blockers=reference;await page.getByRole('button',{name:'Issue gate pass',exact:true}).click();
   await page.getByText('Payment not cleared. Bills: '+reference,{exact:true}).last().waitFor();
   assert.equal(await page.getByRole('link',{name:'Open gate pass in WhatsApp'}).count(),0);
  }
  blockers=false;await page.getByRole('button',{name:'Close bill details'}).click();
 }
 assert.equal(payments.length,0);assert.ok(!calls.includes('/rest/v1/rpc/app_desk_action'));
 bills=[bill,...notes];pass=null;await page.reload();
 await page.getByRole('button',{name:'GATE-TEST',exact:true}).click();
 await page.getByLabel('Mode of payment').selectOption('Cash');
 let heldPayment;
 await page.route('**/api/desk', route => route.request().method() === 'POST' ? (heldPayment = route) : route.continue());
 await page.getByRole('button',{name:/Mark as paid/}).click();
 await page.locator('.sd-dialog .sd-operation-inline').filter({hasText:'Recording payment…'}).waitFor();
 assert.equal(await page.locator('.sd-operation[open]').count(),0,'Payment uses inline pending');
 await page.keyboard.press('Escape'); assert.equal(await page.locator('.sd-dialog[open]').count(),1,'Pending payment keeps details open');
 for(let i=0;i<100 && !heldPayment;i++) await new Promise(resolve=>setTimeout(resolve,10));
 await heldPayment.continue(); await page.unroute('**/api/desk');
 await page.getByRole('dialog',{name:'Payment recorded',exact:true}).locator('.sd-operation-tick').waitFor();
 await page.getByRole('button',{name:'Issue gate pass',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Customer WhatsApp number').inputValue(),'+919876543210');
 await page.getByLabel('Customer WhatsApp number').fill('');await page.getByRole('button',{name:'Issue gate pass',exact:true}).click();
 await page.getByText('Enter a valid customer WhatsApp number with country code',{exact:true}).last().waitFor();
 await page.getByLabel('Customer WhatsApp number').fill('+919876543210');blockers='UNPAID-OTHER-ADVISOR';
 await page.getByRole('button',{name:'Issue gate pass',exact:true}).click();await page.getByText(/UNPAID-OTHER-ADVISOR/).last().waitFor();blockers=false;
 await page.getByRole('button',{name:'Issue gate pass',exact:true}).click();
 const wa=page.getByRole('link',{name:'Open gate pass in WhatsApp'});await wa.waitFor();
 const waUrl=new URL(await wa.getAttribute('href')), message=waUrl.searchParams.get('text');
 assert.equal(waUrl.hostname,'wa.me');assert.equal(waUrl.pathname,'/919876543210');assert.ok(message.includes('one exit'));
 const link=message.match(/http:\/\/127\.0\.0\.1:3131\/g\/[A-Za-z0-9_-]+/)[0],code=new URL(link).pathname.slice(3);
 assert.equal(sha(code),storedHash);
 const expiry=pass.expiresAt;await page.getByRole('button',{name:'Issue gate pass',exact:true}).click();await page.getByText(/Gate pass saved/).last().waitFor();assert.equal(pass.expiresAt,expiry);
 await page.getByRole('button',{name:'Close bill details'}).click();await page.getByRole('button',{name:/^Archive/}).click();await page.getByRole('button',{name:'GATE-TEST',exact:true}).click();await page.getByRole('button',{name:'Issue gate pass',exact:true}).waitFor();
 const anonymous=await browser.newContext({viewport:{width:390,height:844}}), customer=await anonymous.newPage();
 const response=await customer.goto(link);assert.equal(response.status(),200);assert.match(response.headers()['cache-control'],/no-store/);assert.equal(response.headers()['referrer-policy'],'no-referrer');assert.match(response.headers()['x-robots-tag'],/noindex/);
 await customer.getByRole('img',{name:'Gate pass QR code'}).waitFor();assert.equal(confirms,0);
 // Decode the actual locally generated QR with the same scanner package used by the UI.
 await customer.route('**/test-qr/**',route=>{const file=route.request().url().endsWith('worker.min.js')?'qr-scanner-worker.min.js':'qr-scanner.min.js';return route.fulfill({contentType:'text/javascript',body:readFileSync('node_modules/qr-scanner/'+file)});});
 const dataUrl=await customer.getByRole('img').getAttribute('src');
 // Public page CSP intentionally forbids script; decode on the authenticated scanner page instead.
 await context.addCookies([{name:'billdesk_session',value:tokens.guard,url:base}]);
 await page.goto(base+'/security');await page.getByRole('button',{name:'Scan QR'}).waitFor();
 await page.route('**/test-qr/**',route=>{const file=route.request().url().endsWith('worker.min.js')?'qr-scanner-worker.min.js':'qr-scanner.min.js';return route.fulfill({contentType:'text/javascript',body:readFileSync('node_modules/qr-scanner/'+file)});});
 assert.equal(await page.evaluate(async data=>{const {default:Scanner}=await import('/test-qr/qr-scanner.min.js');return (await Scanner.scanImage(data,{returnDetailedScanResult:true})).data;},dataUrl),link);
 await page.getByRole('button',{name:'Scan QR'}).click();await page.getByText(/Camera unavailable/).waitFor();
 await page.getByLabel('Or paste a gate-pass link').fill('https://evil.example/g/'+code);await page.getByRole('button',{name:'Verify link'}).click();await page.getByText('Invalid. Scan or paste a BillDesk gate-pass link.').waitFor();
 await page.getByLabel('Or paste a gate-pass link').fill(link);await page.getByRole('button',{name:'Verify link'}).click();await page.getByRole('button',{name:'Confirm exit',exact:true}).waitFor();assert.equal(confirms,0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const before=calls.length;
 for(const body of [{action:'pdf',target:bill.id},{action:'collect',target:bill.id,method:'Cash'},{action:'create_staff'},{action:'reextract',target:bill.id}])assert.equal((await post('/api/desk',body)).status,403);
 for(const path of ['/api/uploads/init',`/api/uploads/${bill.upload_id}/confirm`,`/api/uploads/${bill.upload_id}/process`,`/api/uploads/${bill.upload_id}/delete`,`/api/bills/${bill.id}/delete`,`/api/bills/${bill.id}/whatsapp`,'/api/gate-passes'])assert.equal((await post(path,{billId:bill.id,phone:'+919876543210'})).ok,false);
 assert.equal(calls.length,before,'Denied security operations never reach financial data');
 assert.equal((await post('/api/gate-passes/verify',{code},'cashier')).ok,false);
 fail=true;await page.getByRole('button',{name:'Retry verification'}).click();await page.getByText('Unable to verify—retry',{exact:true}).last().waitFor();assert.equal(await page.getByRole('button',{name:'Confirm exit',exact:true}).count(),0);
 assert.equal((await fetch(link)).status,503);fail=false;
 await page.getByRole('button',{name:'Retry verification'}).click();await page.getByRole('button',{name:'Confirm exit',exact:true}).click();await page.getByText('Exit confirmed',{exact:true}).waitFor();assert.equal(confirms,1);
 assert.equal((await (await post('/api/gate-passes/confirm-exit',{code})).json()).status,'Already used');assert.equal(confirms,1);
 await customer.reload();await customer.getByRole('heading',{name:'Already used',exact:true}).waitFor();assert.equal(await customer.getByRole('img').count(),1);
 assert.equal((await fetch(base+'/g/'+'z'.repeat(43))).status,404);
 assert.equal((await fetch(link,{method:'HEAD'})).status,200);assert.equal(confirms,1);
 await page.goto(base+'/security/verify/'+'z'.repeat(43));
 await page.getByText('Invalid',{exact:true}).last().waitFor();
 assert.equal(await page.locator('.sd-operation-tick').count(),0);
 assert.equal(await page.getByRole('button',{name:'Confirm exit',exact:true}).count(),0);
 await page.evaluate(()=>document.querySelector('.sd-operation[data-outcome="failure"][open] button')?.click());
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/billdesk-gate-security.png'});
 let releaseLogout;
 await page.route('**/api/auth/logout',route=>new Promise(resolve=>{releaseLogout=async(ok)=>{if(ok)await route.continue();else await route.fulfill({status:503,json:{error:'Try again'}});resolve();};}));
 await page.getByRole('button',{name:'Sign out'}).click();await page.getByRole('dialog',{name:'Signing out…'}).waitFor();
 await releaseLogout(false);await page.getByText('Try again',{exact:true}).last().waitFor();
 await page.getByRole('button',{name:'Sign out'}).click();await page.getByRole('dialog',{name:'Signing out…'}).waitFor();
 await releaseLogout(true);await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();
 console.log('Gate-pass browser passed: paid details, Archive, phone validation, blockers, preset WhatsApp/fallback, QR decode, mobile layout, camera denial, strict links, API role restrictions, outage denial, exit and repeat rejection.');
}catch(e){console.error(log);throw e;}finally{await browser?.close();app.kill();await new Promise(resolve=>server.close(resolve));}
