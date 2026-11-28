// Isolated UI responses only; no production accounts or writes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
const {chromium}=await import(process.env.PLAYWRIGHT_PATH?process.env.PLAYWRIGHT_PATH+'/index.mjs':'playwright');
const base='http://127.0.0.1:3140';
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3140'],{env:{...process.env,SUPABASE_SERVICE_ROLE_KEY:'isolated-test-key',SERVICE_DESK_DEMO:'false'},stdio:['ignore','pipe','pipe']});
let logs='',browser;app.stdout.on('data',v=>logs+=v);app.stderr.on('data',v=>logs+=v);
mkdirSync('output/mobile-navigation',{recursive:true});
try{
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 for(const role of ['service_advisor','cashier','team_leader','super_admin']){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const profile={id:'test-'+role,staff_id:'test_user',full_name:'Test Staff',role,active:true,must_change_password:false};
  await page.route('**/api/**',route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/api/auth/login')return route.fulfill({json:{profile}});
   if(path==='/api/auth/logout')return route.fulfill({json:{ok:true}});
   if(path==='/api/desk'&&route.request().method()==='GET')return route.fulfill({json:{profile,snapshot:{staff:[profile],bills:[],payments:[],audit:[],as_of:new Date().toISOString()}}});
   return route.fulfill({status:403,json:{error:'Unexpected test write'}});
  });
  const settled=()=>page.waitForFunction(()=>!document.querySelector('.sd-operation[open],.sd-operation-inline,.sd-header button:disabled'));
  await page.goto(base);await page.getByLabel('User ID',{exact:true}).fill('test_user');await page.getByLabel('Password',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const opener=page.getByRole('button',{name:'Open navigation',exact:true}),drawer=page.getByRole('dialog',{name:'Navigation',exact:true});
  await opener.waitFor();await settled();
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).count(),0,'Staff actions are tucked into the menu');
  assert.ok((await page.locator('.sd-mobile-header').boundingBox()).height<=76,'Compact mobile header');
  await page.screenshot({path:`output/mobile-navigation/${role}-closed.png`});
  await opener.click();await drawer.waitFor();assert.equal(await opener.getAttribute('aria-expanded'),'true');assert.equal(await drawer.evaluate(el=>el.matches(':modal')),true);
  assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
  await page.keyboard.press('Shift+Tab');assert.ok(await drawer.evaluate(el=>el.contains(document.activeElement)),'Focus remains inside the menu');
  await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});assert.equal(await opener.evaluate(el=>el===document.activeElement),true,'Focus returns to the menu button');
  assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  await opener.click();await page.mouse.click(380,400);await drawer.waitFor({state:'hidden'});
  await opener.click();await page.screenshot({path:`output/mobile-navigation/${role}-open.png`});
  const destination=role==='super_admin'?'Staff accounts':role==='cashier'?/^Receivables/:role==='team_leader'?'Approvals & follow-up':/^Bill archive/;
  await drawer.getByRole('button',{name:destination,exact:typeof destination==='string'}).click();await drawer.waitFor({state:'hidden'});
  if(role==='super_admin')await page.getByRole('heading',{name:'Create a staff account'}).waitFor();
  if(role==='cashier')await page.getByRole('heading',{name:'Receivables',exact:true}).first().waitFor();
  await opener.click();assert.equal(await drawer.getByRole('button',{name:destination,exact:typeof destination==='string'}).getAttribute('aria-current'),'page');
  await page.setViewportSize({width:1280,height:900});await drawer.waitFor({state:'hidden'});assert.equal(await page.locator('.sd-desktop-sidebar').isVisible(),true);assert.equal(await opener.isVisible(),false);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  await page.setViewportSize({width:390,height:844});await opener.click();await drawer.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();await settled();
  assert.equal(await drawer.count(),0);assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Mobile navigation passed for advisor, cashier, TL and admin: compact header, side drawer, selection/close, Escape, backdrop, focus containment/return, resize, desktop sidebar and sign-out.');
}catch(e){console.error(logs);throw e;}finally{await browser?.close();app.kill();}
