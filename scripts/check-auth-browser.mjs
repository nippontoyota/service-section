// Run after a build. Authentication/workspace requests are intercepted; no real account is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH+'/index.mjs' : 'playwright');
const base='http://127.0.0.1:3133';
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3133'],{env:{...process.env,SUPABASE_SERVICE_ROLE_KEY:'isolated-auth-test-key',SERVICE_DESK_DEMO:'false'},stdio:['ignore','pipe','pipe']});
let log='';app.stdout.on('data',c=>log+=c);app.stderr.on('data',c=>log+=c);
let browser;
async function ready(read) {
 for(let i=0;i<100;i++){const value=read();if(value)return value;await new Promise(r=>setTimeout(r,20));}
 throw new Error('Expected intercepted request did not arrive');
}
try {
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addLocatorHandler(page.locator('.sd-operation[data-outcome="failure"][open]'), dialog => dialog.getByRole('button',{name:'Continue'}).click());
 const profile={id:'test-cashier',staff_id:'cashier01',full_name:'Test Cashier',role:'cashier',active:true,must_change_password:false};
 let loginReply, logoutReply, snapshotReply, logins=0,logouts=0;
 await page.route('**/api/auth/login',async route=>{logins++;await new Promise(resolve=>{loginReply=async(ok,account=profile)=>{await route.fulfill({status:ok?200:401,json:ok?{profile:account}:{error:'Invalid user ID or password.'}});resolve();};});});
 await page.route('**/api/auth/logout',async route=>{logouts++;await new Promise(resolve=>{logoutReply=async(ok)=>{await route.fulfill({status:ok?200:503,json:ok?{ok:true}:{error:'Could not sign out. Please retry.'}});resolve();};});});
 await page.route('**/api/desk',async route=>{await new Promise(resolve=>{snapshotReply=async()=>{await route.fulfill({json:{profile,snapshot:{bills:[],payments:[],staff:[profile],audit:[],as_of:new Date().toISOString()}}});resolve();};});});
 await page.goto(base);await page.getByLabel('User ID',{exact:true}).fill('cashier01');await page.getByLabel('Password',{exact:true}).fill('test-password');
 loginReply=null;await page.getByRole('button',{name:'Sign in',exact:true}).click();await ready(()=>loginReply);
 const progress=page.getByRole('dialog',{name:'Signing in…',exact:true});await progress.waitFor();
 assert.equal(await progress.evaluate(d=>d.matches(':modal')),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.keyboard.press('Escape');assert.equal(await progress.isVisible(),true);
 await page.keyboard.press('Enter');assert.equal(logins,1);
 await page.screenshot({path:'/tmp/billdesk-signing-in.png'});
 await loginReply(false);await page.getByRole('alert').filter({hasText:'Invalid user ID or password.'}).last().waitFor();
 assert.equal(await progress.isVisible(),false);assert.equal(await page.getByLabel('User ID',{exact:true}).inputValue(),'cashier01');
 assert.equal(await page.getByLabel('Password',{exact:true}).inputValue(),'test-password');
 profile.role='service_advisor';
 await page.evaluate(() => sessionStorage.setItem('desk-sharing-batch:test-cashier','["draft-id"]'));
 loginReply=null;await page.getByRole('button',{name:'Sign in',exact:true}).click();await ready(()=>loginReply);await progress.waitFor();await loginReply(true);
 await page.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>e.name.endsWith('/api/auth/login')));
 // Wait for the workspace request to start, keeping the progress view across both requests.
 await ready(()=>snapshotReply);
 assert.ok(snapshotReply);assert.equal(await progress.isVisible(),true);
 await page.getByRole('button',{name:'Upload bills',exact:true,includeHidden:true}).waitFor({state:'attached'});
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('desk-sharing-batch:test-cashier')),null,'Retired advisor sharing queues must be cleared');
 await snapshotReply();
 await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
 await page.emulateMedia({reducedMotion:'reduce'});
 logoutReply=null;await page.getByRole('button',{name:'Sign out',exact:true}).click();await ready(()=>logoutReply);
 const out=page.getByRole('dialog',{name:'Signing out…',exact:true});await out.waitFor();
 assert.equal(await out.locator('.sd-toyota-emblem').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.keyboard.press('Enter');assert.equal(logouts,1);
 await logoutReply(false);await page.getByText('Could not sign out. Please retry.',{exact:true}).last().waitFor();assert.equal(await out.isVisible(),false);
 await page.setViewportSize({width:1440,height:900});await page.emulateMedia({reducedMotion:'no-preference'});
 logoutReply=null;await page.getByRole('button',{name:'Sign out',exact:true}).click();await ready(()=>logoutReply);await out.waitFor();
 await page.screenshot({path:'/tmp/billdesk-signing-out.png'});await logoutReply(true);
 await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();await page.locator('.sd-operation[open]').waitFor({state:'hidden'});assert.equal(await out.isVisible(),false);
 let releaseSecurity;
 await page.route('**/security',route=>new Promise(resolve=>{releaseSecurity=async()=>{await route.fulfill({contentType:'text/html',body:'<h1>Security workspace</h1>'});resolve();};}));
 await page.getByLabel('User ID',{exact:true}).fill('guard01');await page.getByLabel('Password',{exact:true}).fill('test-password');
 loginReply=null;await page.getByRole('button',{name:'Sign in',exact:true}).click();await ready(()=>loginReply);await progress.waitFor();
 await loginReply(true,{...profile,role:'security'});
 await ready(()=>releaseSecurity);
 assert.ok(releaseSecurity);await releaseSecurity();
 await page.getByRole('heading',{name:'Security workspace'}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('Auth browser passed: immediate modal feedback, full login/refresh transition, duplicate prevention, preserved inputs on failure, logout failure/retry, reduced motion and mobile/desktop layout.');
} catch(error){console.error(log);throw error;} finally{await browser?.close();app.kill();}
