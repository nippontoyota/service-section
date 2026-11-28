// Synthetic responses only: verify request counts without writing production data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fixtureSnapshot } = require('/tmp/cashier-bill-tests/test-fixtures.js');
const { demoApproval, normalizeApprovalRequest } = require('/tmp/cashier-bill-tests/approval.js');
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH + '/index.mjs' : 'playwright');
const base = 'http://127.0.0.1:3138';
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '3138'], {env:{...process.env,SUPABASE_SERVICE_ROLE_KEY:'isolated-test-key',SERVICE_DESK_DEMO:'false'},stdio:['ignore','pipe','pipe']});
let logs = '', browser;
app.stdout.on('data', v => { logs += v; }); app.stderr.on('data', v => { logs += v; });
const waitFor = async condition => { for(let i=0;i<200;i++){if(condition())return;await new Promise(r=>setTimeout(r,25));}assert.fail('Expected request did not arrive'); };
try {
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  let snapshot = fixtureSnapshot();
  const profile = snapshot.staff.find(p => p.role === 'service_advisor');
  snapshot.payments = []; snapshot.bills = [snapshot.bills[0]];
  const bill = snapshot.bills[0];
  Object.assign(bill,{approval_status:'pending',approved_at:null,approved_by:null,payment_route:null});
  bill.uploads.confirmed_at = null;
  snapshot = demoApproval(snapshot, profile, normalizeApprovalRequest({action:'save_request',requestId:crypto.randomUUID(),kind:'insurance',entries:[{billId:bill.id,insurerPaise:bill.amount_paise-200000}],details:{insurer:'Test insurer',responsibleStaffId:profile.id}}));
  let reads = 0, writes = 0, confirmations = 0, hold = false, pending;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if(path === '/api/auth/login')return route.fulfill({json:{profile}});
    if(path === '/api/auth/logout')return route.fulfill({json:{ok:true}});
    if(path.endsWith('/confirm')){confirmations++;return route.fulfill({status:400,json:{error:'Unexpected submission'}});}
    if(path !== '/api/desk')return route.fulfill({status:404,json:{error:'Unexpected endpoint'}});
    if(route.request().method() === 'GET'){
      reads++;
      if(hold){pending=route;return;}
      return route.fulfill({json:{profile,snapshot}});
    }
    writes++;
    snapshot=demoApproval(snapshot,profile,normalizeApprovalRequest(route.request().postDataJSON()));
    return route.fulfill({json:{ok:true}});
  });
  const settled=()=>page.waitForFunction(()=>!document.querySelector('.sd-operation[open],.sd-operation-inline,.sd-header button:disabled'));
  await page.goto(base);await page.clock.install();await page.clock.fastForward(120100);
  assert.equal(reads,0,'No polling while signed out');
  await page.getByLabel('User ID',{exact:true}).fill('advisor01');await page.getByLabel('Password',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();await settled();
  assert.equal(reads,1,'Sign-in loads the workspace once');
  await page.clock.fastForward(30100);assert.equal(reads,1,'No 30-second polling');
  hold=true;await page.clock.fastForward(60100);await waitFor(()=>pending);const inFlightReads=reads;
  await page.clock.fastForward(60100);assert.equal(reads,inFlightReads,'Background reads cannot overlap');
  hold=false;await pending.fulfill({json:{profile,snapshot}});await page.waitForTimeout(100);
  await page.getByRole('button',{name:/Upload bills/}).click();
  const selector=page.getByLabel('Payment type for '+bill.invoice_reference,{exact:true});
  assert.equal(await selector.evaluate(el=>getComputedStyle(el).color),'rgb(32, 33, 36)');
  const before=reads;
  await page.getByRole('button',{name:'Open insurer form',exact:true}).click();
  await page.getByLabel('Customer pays (₹)').fill('2500');await page.getByLabel('Reason / remarks').fill('Testing local edits');
  await page.clock.fastForward(120100);assert.equal(reads,before,'No polling while a form is open');assert.equal(writes,0,'Typing does not save or create requests');
  await page.getByRole('button',{name:'Close payment form',exact:true}).click();
  await page.getByRole('button',{name:'Submit reviewed bills',exact:true}).click();
  await page.getByRole('dialog',{name:'Upload and review bills',exact:true}).getByText(/Contact, responsible staff and a current or future due date/).waitFor();
  assert.equal(confirmations,0,'Incomplete drafts are checked before sending a confirmation request');
  await page.getByRole('button',{name:'Open insurer form',exact:true}).click();
  await page.getByLabel('Insurer contact person',{exact:true}).fill('Claims desk');await page.getByLabel('Contact number',{exact:true}).fill('9876543210');await page.getByLabel('Expected insurer payment date').fill('2099-12-01');
  await page.getByRole('button',{name:'Save request draft',exact:true}).click();await settled();
  assert.equal(writes,1,'Explicit save sends exactly one write');assert.equal(reads,before+1,'Save refreshes the workspace once');
  await page.getByRole('button',{name:'Close upload dialog',exact:true}).click();
  const afterSave=reads;
  await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));
  await page.clock.fastForward(120100);assert.equal(reads,afterSave,'No polling in hidden tabs');
  await page.evaluate(()=>delete document.hidden);await page.clock.fastForward(60100);await waitFor(()=>reads===afterSave+1);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await settled();assert.equal(reads,afterSave+2,'Manual refresh remains immediate');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();await settled();
  const afterLogout=reads;await page.clock.fastForward(120100);assert.equal(reads,afterLogout);
  assert.deepEqual(errors,[]);
  console.log('Refresh browser passed: neutral selector, no per-keystroke writes, one save/refresh, local submission validation, minute polling, no signed-out/hidden/dialog polling, no overlapping reads, manual refresh retained.');
} catch(e){console.error(logs);throw e;}finally{await browser?.close();app.kill();}
