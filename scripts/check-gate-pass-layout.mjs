import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync} from 'node:fs';
import QRCode from 'qrcode';
import {PDFParse} from 'pdf-parse';
const require=createRequire(import.meta.url);
const {gatePassDocument}=require('/tmp/cashier-bill-tests/gate-pass-document.js');
const {chromium}=await import(process.env.PLAYWRIGHT_PATH?process.env.PLAYWRIGHT_PATH+'/index.mjs':'playwright');
const pass={id:'layout-test',number:7,status:'Valid',customerName:'Synthetic Service Customer',vehicle:'KL01AB1234',issuedBy:'Test Cashier',issuedAt:'2026-11-28T10:00:00Z',expiresAt:'2026-11-29T10:00:00Z',documents:[0,1].map(i=>({billId:String(i),invoiceNumber:'INV-TEST-'+i,invoiceDate:'2026-11-28',jobNumber:'RO-TEST-'+i,jobDate:'2026-11-28'}))};
const qr=await QRCode.toDataURL('https://billdesk.example/g/'+ 'a'.repeat(43),{width:480,margin:4,errorCorrectionLevel:'M'});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
mkdirSync('output/compact-checks',{recursive:true});
try{
 const page=await browser.newPage();
 for(const [width,height] of [[390,844],[375,667],[1440,900]]){
  await page.setViewportSize({width,height});await page.goto('about:blank');await page.setContent(gatePassDocument(pass,qr,'layout-test'));
  const image=page.getByRole('img',{name:'Gate pass QR code'});await image.waitFor();const rect=await image.boundingBox();
  assert.ok(rect.width>=200,'QR must be large enough on mobile');assert.ok(Math.abs(rect.x+rect.width/2-width/2)<=2,'QR is centred');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  await page.screenshot({path:`output/compact-checks/gate-pass-${width}.png`,fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),`entire default pass fits ${width}×${height}: height ${await page.evaluate(()=>document.documentElement.scrollHeight)}`);
  await page.screenshot({path:`output/compact-checks/gate-pass-${width}.png`});
 }
 await page.emulateMedia({media:'print'});await page.pdf({path:'output/compact-checks/gate-pass.pdf',preferCSSPageSize:true});
 const pdf=new PDFParse({data:new Uint8Array(readFileSync('output/compact-checks/gate-pass.pdf'))});
 const text=await pdf.getText();assert.equal(text.total,1,'printed pass fits one page');assert.ok(text.text.includes('INV-TEST-1'));await pdf.destroy();
 await page.goto('about:blank');await page.setContent(gatePassDocument({...pass,documents:[...pass.documents,...pass.documents.map(d=>({...d,invoiceNumber:d.invoiceNumber+'-extra'}))]},qr,'layout-test'));await page.pdf({path:'output/compact-checks/gate-pass-extra.pdf',preferCSSPageSize:true});const extra=new PDFParse({data:new Uint8Array(readFileSync('output/compact-checks/gate-pass-extra.pdf'))});assert.ok((await extra.getText()).text.includes('INV-TEST-1-extra'),'print includes collapsed invoices');await extra.destroy();
 console.log('Gate pass layout passed: larger centred QR, two invoices in one view at 375×667 and 390×844, desktop fit and one-page print.');
}finally{await browser.close();}
