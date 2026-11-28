import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { fixtureSnapshot } from './test-fixtures';
import { demoApproval, normalizeApprovalRequest, arrangementApproved } from './approval';
import { demoSettlement, normalizeSettlementRequest, payerBalance, releaseCleared } from './settlement';
import { demoAction } from './desk-demo';
import { approvedPdf } from './pdf/approved-copy';
import { customerContact } from './pdf/extract';

test('advisor request, TL correction and approval, cashier collection and follow-up stay separate', () => {
 let data=fixtureSnapshot(); data.payments=[]; data.bills=[{...data.bills[0],approval_status:'pending',approved_by:null,approved_at:null}];
 const advisor=data.staff.find(p=>p.role==='service_advisor')!, tl=data.staff.find(p=>p.role==='team_leader')!, cashier=data.staff.find(p=>p.role==='cashier')!;
 const id=data.bills[0].id;
 const details={insurer:'Insurance Ltd',contactPerson:'Claims desk',contactNumber:'+919876543210',responsibleStaffId:advisor.id,dueDate:'2099-12-01'};
 const act=(actor: typeof advisor, action: string, extra: Record<string, unknown>={})=>{
  const s=data.bills[0].settlement;
  const request=normalizeApprovalRequest({action,requestId:crypto.randomUUID(),settlementId:s?.id,revision:s?.revision,...extra});
  data=demoApproval(data,actor,request);return request;
 };
 const entries=[{billId:id,insurerPaise:1800000}];
 act(advisor,'save_request',{kind:'insurance',details,entries});
 assert.equal(releaseCleared(data.bills[0],[]),false);
 const collect=()=>demoSettlement(data,cashier,normalizeSettlementRequest({action:'collect_batch',requestId:crypto.randomUUID(),entries:[{billId:id,amountPaise:200000}],payer:'customer',method:'Cash',details:{}}));
 assert.throws(collect,/TL approval/);
 assert.throws(()=>demoAction(data,cashier,'approve',id),/TL approval/);
 act(advisor,'submit_request');
 assert.throws(()=>act(advisor,'approve_request',{kind:'insurance',details,entries}),/Team Leader/);
 const beforeRevision=data.bills[0].settlement!.revision;
 act(tl,'return_request',{reason:'Correct split'});
 assert.throws(()=>demoApproval(data,tl,normalizeApprovalRequest({action:'approve_request',requestId:crypto.randomUUID(),settlementId:data.bills[0].settlement!.id,revision:beforeRevision,kind:'insurance',details,entries})),/changed/);
 act(advisor,'save_request',{kind:'insurance',details,entries});act(advisor,'submit_request');
 const approval=act(tl,'approve_request',{kind:'insurance',details:{...details,approvedBy:'forged'},entries});
 assert.deepEqual(demoApproval(data,tl,approval),data);
 assert.equal(data.bills[0].settlement!.approved_name,tl.full_name);
 assert.equal(data.bills[0].settlement!.details.approvedBy,undefined);
 assert.equal(data.payments.length,0);
 data=collect();assert.equal(releaseCleared(data.bills[0],data.payments),false);
 act(cashier,'acknowledge_request');assert.equal(releaseCleared(data.bills[0],data.payments),true);
 act(tl,'add_followup',{followup:{contact:'Claims desk',note:'Called insurer',nextDate:'2099-01-01',promisedDate:'2099-01-03'}});
 assert.equal(data.bills[0].settlement!.followups!.length,1);
 assert.equal(payerBalance(data.bills[0],data.payments,'insurer'),1800000);
 assert.throws(()=>demoSettlement(data,tl,normalizeSettlementRequest({action:'collect_batch',requestId:crypto.randomUUID(),entries:[{billId:id,amountPaise:100}],payer:'insurer',method:'Cash',details:{}})),/Cashier/);
 assert.equal(arrangementApproved({...data.bills[0].settlement!,revoked:true}),false);
});

test('customer phone extraction excludes dealer and insurer contacts and rejects ambiguity',()=>{
 assert.equal(customerContact('Dealer Mobile: 9999999999\nDetails of Receiver (Billed To): Insurer\nMobile: 8888888888\nDetails of Consignee (Shipped To): Customer\nMobile: 9876543210\nPlace of Supply: Kerala'),'+919876543210');
 assert.equal(customerContact('Dealer Mobile: 9999999999'),'');
 assert.equal(customerContact('Details of Consignee (Shipped To): Customer\nMobile: 9876543210\nPhone: 9876543211\nPlace of Supply: Kerala'),'');
});

test('approved PDF isolates invoice pages and adds a stamp without covering invoice content',async()=>{
 const source=await PDFDocument.create();const font=await source.embedFont(StandardFonts.Helvetica);
 for(const text of ['Other customer','Approved invoice','Third customer'])source.addPage([500,700]).drawText(text,{font,size:14,x:20,y:650});
 const original=await source.save();
 const output=await approvedPdf(original,2,2,{name:'Meera Menon',at:'2026-11-28T10:00:00Z',number:12,revoked:false});
 const doc=await PDFDocument.load(output);
 assert.equal(doc.getPageCount(),1);assert.equal(doc.getPages()[0].getHeight(),792);
 assert.equal((await PDFDocument.load(original)).getPageCount(),3);
 await assert.rejects(approvedPdf(original,0,1,{name:'TL',at:new Date().toISOString(),number:1,revoked:false}),/page range/);
});
