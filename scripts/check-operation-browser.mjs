// Synthetic staff responses only. No production accounts or writes are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH + '/index.mjs' : 'playwright');
const base = 'http://127.0.0.1:3135';
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '3135'], {env:{...process.env,SUPABASE_SERVICE_ROLE_KEY:'isolated-test-key',SERVICE_DESK_DEMO:'false'},stdio:['ignore','pipe','pipe']});
let logs = '', browser;
app.stdout.on('data', value => { logs += value; }); app.stderr.on('data', value => { logs += value; });
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve,100)); }
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const profile = {id:'admin',staff_id:'admin01',full_name:'Test Admin',role:'super_admin',active:true,must_change_password:false};
  const staff = [profile];
  let writes = 0, pending, failRefresh = false;
  await page.route('**/api/auth/login', route => route.fulfill({json:{profile}}));
  await page.route('**/api/desk', route => {
    if (route.request().method() === 'GET') return route.fulfill(failRefresh ? {status:503,json:{error:'Synthetic refresh failure'}} : {json:{profile,snapshot:{bills:[],payments:[],staff,audit:[],as_of:new Date().toISOString()}}});
    writes++;
    pending = route;
  });
  const button = name => page.getByRole('button',{name,exact:true});
  const settled = () => page.waitForFunction(() => !document.querySelector('.sd-operation[open], .sd-operation-inline'));
  await page.goto(base);
  await page.getByLabel('User ID',{exact:true}).fill('admin01'); await page.getByLabel('Password',{exact:true}).fill('test-password'); await button('Sign in').click();
  await button('Staff accounts').click();
  await page.clock.install();
  const fillAccount = async id => { await page.getByLabel('Full name',{exact:true}).fill('Synthetic Staff'); await page.getByLabel('User ID',{exact:true}).fill(id); await page.getByLabel('Password',{exact:true}).fill('abcdef'); };
  await fillAccount('staff01'); await button('Create account').click();
  const creating = page.locator('.sd-operation-inline').filter({hasText:'Creating staff account…'}); await creating.waitFor();
  await button('Create account').dispatchEvent('click'); assert.equal(writes,1);
  assert.equal(await page.getByLabel('Full name',{exact:true}).isDisabled(),true,'Pending writes protect entered values');
  assert(await page.locator('.sd-main').evaluate(el => el.getBoundingClientRect().top < 5),'Inline status must not displace the workspace grid');
  assert.equal(await page.locator('.sd-operation[open]').count(),0,'Routine writes must not open the loading dialog');
  await page.clock.fastForward(15_100);
  assert.equal(await page.locator('.sd-operation[open]').count(),0);
  staff.push({...profile,id:'staff',staff_id:'staff01',full_name:'Synthetic Staff',role:'service_advisor'});
  failRefresh = true;
  await pending.fulfill({json:{ok:true}});
  await page.getByRole('dialog',{name:'Changes saved',exact:true}).locator('.sd-operation-tick').waitFor();
  await settled();
  await page.getByText(/Action succeeded, but the workspace could not refresh/).waitFor();
  assert.equal(await page.getByLabel('Password',{exact:true}).inputValue(),'');
  failRefresh = false; await button('Retry refresh').click(); await settled();
  const row = page.getByRole('row').filter({hasText:'Synthetic Staff'});
  for (const [action,label] of [['Disable','Changing staff access…'],['Reset password','Resetting staff password…'],['Delete account','Deleting staff account…']]) {
    pending = null;
    await row.getByRole('button',{name:action,exact:true}).click();
    await page.locator('.sd-operation-inline').filter({hasText:label}).waitFor();
    assert.equal(await page.locator('.sd-operation[open]').count(),0);
    if (action === 'Disable') staff[1].active = false;
    if (action === 'Delete account') staff.pop();
    await pending.fulfill({json: action === 'Reset password' ? {temporaryPassword:'synthetic-password'} : {ok:true}});
    await settled();
  }
  // A timed-out write may have committed. Retain input, block resubmission, then reconcile by GET.
  await fillAccount('staff02'); pending = null; const before = writes;
  await button('Create account').click(); await creating.waitFor();
  for (let i=0; i<100 && !pending; i++) await new Promise(resolve => setTimeout(resolve,10));
  assert.ok(pending);
  staff.push({...profile,id:'staff2',staff_id:'staff02',full_name:'Synthetic Staff',role:'service_advisor'});
  await page.clock.fastForward(120_100);
  const uncertain = page.getByRole('dialog',{name:'Result uncertain',exact:true}); await uncertain.waitFor();
  assert.equal(await uncertain.locator('.sd-operation-tick').count(),0);
  await button('Continue').click();
  assert.equal(await page.getByLabel('User ID',{exact:true}).inputValue(),'staff02');
  assert.equal(await page.getByLabel('Password',{exact:true}).inputValue(),'abcdef');
  await button('Create account').click(); assert.equal(writes,before+1);
  await button('Retry refresh').click(); await settled();
  await page.getByRole('cell').filter({hasText:'staff02'}).waitFor();
  assert.equal(writes,before+1,'Refreshing uncertain status must never repeat the write');
  profile.must_change_password = true;
  await button('Refresh').click(); await settled();
  await page.getByLabel('New password').fill('synthetic-new-password');
  await button('Save password').click(); await page.locator('.sd-operation-inline').filter({hasText:'Changing password…'}).waitFor();
  profile.must_change_password = false;
  await pending.fulfill({json:{ok:true}}); await settled();
  await button('Staff accounts').waitFor();
  assert.deepEqual(errors,[]);
  console.log('Operation browser passed: contextual staff/password feedback, inline pending without a modal, retained success screen, synchronous duplicate lock, confirmed writes with refresh warnings, 120-second uncertain timeout, preserved forms, mandatory status refresh and no resubmission.');
} catch (error) { console.error(logs); throw error; }
finally { await browser?.close(); app.kill(); }
