begin;
create table public.settlement_cases (
 id uuid primary key,
 number bigint generated always as identity unique,
 kind text not null check (kind in ('insurance','credit')),
 details jsonb not null default '{}',
 revoked boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 recorded_by uuid references profiles(id) on delete set null
);
alter table public.bills add column settlement_id uuid references public.settlement_cases(id);
alter table public.bills add column customer_share_paise bigint check (customer_share_paise >= 0 and customer_share_paise <= amount_paise);
alter table public.bills add column credit_limit_paise bigint check (credit_limit_paise >= 0 and credit_limit_paise <= amount_paise);
alter table public.payments add column payer text not null default 'customer' check (payer in ('customer','insurer'));
create table public.desk_operations (
 id uuid primary key, staff_id uuid references profiles(id) on delete set null,
 payload jsonb not null, created_at timestamptz not null default clock_timestamp()
);
alter table public.payments add column collection_id uuid references public.desk_operations(id);
alter table public.settlement_cases enable row level security;
alter table public.desk_operations enable row level security;
revoke all on public.settlement_cases,public.desk_operations from public,anon,authenticated;
grant all on public.settlement_cases,public.desk_operations to service_role;
grant usage,select on sequence public.settlement_cases_number_seq to service_role;
create index bills_settlement_id on public.bills(settlement_id);
create trigger gate_lock_settlements before insert or update or delete on public.settlement_cases for each statement execute function public.gate_write_lock();

create function public.bill_payer_balance(target uuid, who text) returns bigint language sql stable set search_path=public as $$
 select (case when who='customer' then case when s.kind='insurance' then b.customer_share_paise else b.amount_paise end
 else case when s.kind='insurance' then b.amount_paise-b.customer_share_paise else 0 end end)
 - (select coalesce(sum(p.amount_paise),0) from payments p where p.bill_id=b.id and not p.is_archived and p.payer=who)
 from bills b left join settlement_cases s on s.id=b.settlement_id where b.id=target
$$;
create or replace function public.require_full_bill_payment() returns trigger language plpgsql security definer set search_path=public as $$
declare b bills; original payments; begin
 if new.is_archived then return new; end if;
 select * into b from bills where id=new.bill_id for update;
 if b.approval_status<>'approved' or b.amount_paise is null then raise exception 'Approved invoice total required'; end if;
 if new.source='reversal' then
  select * into original from payments where id=new.reversal_of;
  if original.id is null or original.is_archived or original.source='reversal' or original.bill_id<>new.bill_id
   or new.amount_paise<>-original.amount_paise or new.payer<>original.payer then raise exception 'Invalid reversal'; end if;
 end if;
 if bill_payer_balance(b.id,'customer')<0 or bill_payer_balance(b.id,'insurer')<0
 or (select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and not is_archived and payer='customer')<0
 or (select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and not is_archived and payer='insurer')<0 then
 raise exception 'Collection exceeds the outstanding balance'; end if;
 return new;
end $$;

create function public.app_settle_bills(staff uuid, request_id uuid, payload jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare op text:=payload->>'action'; e jsonb; b bills; first_bill bills; s settlement_cases; prior desk_operations;
 amount bigint; share bigint; due bigint; received bigint; ids uuid[]; form_details jsonb:=coalesce(payload->'details','{}');
 method text:=coalesce(payload->>'method',''); reference text:=nullif(trim(payload->>'transactionId'),''); who text:=payload->>'payer';
begin
 perform gate_lock(); perform app_set_actor(staff);
 if public.current_role() not in ('cashier','super_admin') then raise exception 'Cashier access required'; end if;
 if request_id is null then raise exception 'Collection reference required'; end if;
 select * into prior from desk_operations where id=request_id;
 if found then
  if prior.staff_id<>staff or prior.payload<>payload then raise exception 'Collection reference already used'; end if;
  return;
 end if;
 if op is null or op not in ('collect_batch','arrange','update_settlement','revoke_settlement') then raise exception 'Unknown settlement operation'; end if;
 if jsonb_typeof(form_details)<>'object' or length(form_details::text)>12000 then raise exception 'Invalid form form_details'; end if;
 if op in ('update_settlement','revoke_settlement') then
  select * into s from settlement_cases where id=(payload->>'settlementId')::uuid for update;
  if s.id is null then raise exception 'Settlement not found'; end if;
  if op='revoke_settlement' then
   if public.current_role()<>'super_admin' or nullif(trim(form_details->>'remarks'),'') is null then raise exception 'Admin correction and reason required'; end if;
   update settlement_cases set revoked=true where id=s.id;
  else
   update settlement_cases set details=settlement_cases.details || (form_details - array['insurer','contactPerson','contactNumber','responsibleStaff','approvedBy','approvedOn','dueDate']) where id=s.id;
  end if;
  insert into desk_operations(id,staff_id,payload) values(request_id,staff,payload);
  insert into audit_events(actor_id,bill_id,action,detail)
   select staff,id,op,jsonb_build_object('requestId',request_id,'settlementId',s.id,'before',s.details,'changes',form_details) from bills where settlement_id=s.id;
  return;
 end if;
 if public.current_role()<>'cashier' then raise exception 'Cashier role required'; end if;
 if who is null or who not in ('customer','insurer') then raise exception 'Select payer'; end if;
 if jsonb_typeof(payload->'entries') is distinct from 'array' or jsonb_array_length(payload->'entries') not between 1 and 100 then raise exception 'Select between 1 and 100 bills'; end if;
 select array_agg((value->>'billId')::uuid) into ids from jsonb_array_elements(payload->'entries');
 if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'Duplicate bill allocation'; end if;
 select * into first_bill from bills where id=ids[1];
 if first_bill.id is null then raise exception 'Bill not found'; end if;
 if exists(select 1 from jsonb_array_elements(payload->'entries') value where (value->>'amountPaise')::numeric>0) then
  if not (method in ('Cash','GPay','Cheque','Demand Draft') or (left(method,7)='Other: ' and length(trim(substring(method from 8))) between 1 and 100)) then raise exception 'Choose payment method'; end if;
  if method in ('GPay','Cheque','Demand Draft') and reference is null then raise exception 'Payment reference required'; end if;
  if length(reference)>100 then raise exception 'Payment reference too long'; end if;
 else
  if op='collect_batch' then raise exception 'Enter an amount to collect'; end if;
 end if;
 if method not in ('GPay','Cheque','Demand Draft') then reference:=null; end if;
 insert into desk_operations(id,staff_id,payload) values(request_id,staff,payload);
 if op='arrange' then
  if who<>'customer' then raise exception 'Initial collection must be from customer'; end if;
  if payload->>'kind'='insurance' then
   if nullif(trim(form_details->>'insurer'),'') is null then raise exception 'Insurer name required'; end if;
  elsif payload->>'kind'='credit' then
   if nullif(trim(form_details->>'approvedBy'),'') is null or nullif(form_details->>'approvedOn','') is null or nullif(form_details->>'dueDate','') is null
    or (form_details->>'dueDate')::date<(form_details->>'approvedOn')::date then raise exception 'Outside approver, approval date and valid due date required'; end if;
  else raise exception 'Select insurance or credit'; end if;
  insert into settlement_cases(id,kind,details,recorded_by) values(request_id,payload->>'kind',form_details,staff) returning * into s;
 end if;
 for e in select value from jsonb_array_elements(payload->'entries') loop
  select * into b from bills where id=(e->>'billId')::uuid for update;
  if b.id is null or b.amount_paise is null or b.invoice_date is null or nullif(trim(b.invoice_reference),'') is null
   or not exists(select 1 from uploads where id=b.upload_id and confirmed_at is not null) then raise exception 'Readable submitted invoice required'; end if;
  if b.customer_id<>first_bill.customer_id or (b.id<>first_bill.id and (gate_vehicle(first_bill.vehicle_no_display)='' or gate_vehicle(b.vehicle_no_display)<>gate_vehicle(first_bill.vehicle_no_display))) then raise exception 'Select bills for one customer and vehicle'; end if;
  if jsonb_typeof(e->'amountPaise') is distinct from 'number' or (e->>'amountPaise')::numeric<>trunc((e->>'amountPaise')::numeric) then raise exception 'Invalid amount'; end if;
  amount:=(e->>'amountPaise')::bigint;
  if amount<0 or amount>100000000000 then raise exception 'Invalid amount'; end if;
  if op='arrange' then
   if exists(select 1 from settlement_cases where id=b.settlement_id and not revoked) then raise exception 'Correct the existing arrangement before replacing it'; end if;
   if s.kind='insurance' then
    if jsonb_typeof(e->'customerSharePaise') is distinct from 'number' or (e->>'customerSharePaise')::numeric<>trunc((e->>'customerSharePaise')::numeric) then raise exception 'Customer share required'; end if;
    share:=(e->>'customerSharePaise')::bigint;
    if share<0 or share>b.amount_paise
     or share<(select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and payer='customer' and not is_archived)+amount
     or b.amount_paise-share<(select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and payer='insurer' and not is_archived) then raise exception 'Customer share must cover collections and fit the invoice total'; end if;
   else
    if (select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and payer='insurer' and not is_archived)<>0 then raise exception 'Reverse insurer payments before changing to credit'; end if;
    share:=null;
   end if;
   select coalesce(sum(amount_paise),0) into received from payments where bill_id=b.id and not is_archived;
   if b.amount_paise-received-amount<0 then raise exception 'Collection exceeds the outstanding balance'; end if;
   update bills set settlement_id=s.id,customer_share_paise=share,credit_limit_paise=case when s.kind='credit' then b.amount_paise-received-amount end where id=b.id;
  end if;
  due:=bill_payer_balance(b.id,who);
  if amount>due then raise exception 'Collection exceeds the outstanding balance'; end if;
  if op='collect_batch' and b.settlement_id is null and amount<>due then raise exception 'Use a credit form for part payment'; end if;
  update bills set approval_status='approved',approved_by=coalesce(approved_by,staff),approved_at=coalesce(approved_at,clock_timestamp()) where id=b.id;
  if amount>0 then insert into payments(bill_id,amount_paise,method,transaction_id,payer,collection_id,recorded_by,source)
   values(b.id,amount,method,reference,who,request_id,staff,'cashier'); end if;
  select coalesce(sum(amount_paise),0) into received from payments where bill_id=b.id and not is_archived;
  update bills set status=case when received=amount_paise then 'paid' else 'ready' end,
   paid_at=case when received=amount_paise then clock_timestamp() end,paid_by=case when received=amount_paise then staff end where id=b.id;
  insert into audit_events(actor_id,bill_id,action,detail) values(staff,b.id,op,jsonb_build_object('requestId',request_id,'amount_paise',amount,'payer',who,'settlementId',case when op='arrange' then s.id else b.settlement_id end,'arrangement',case when op='arrange' then to_jsonb(s) end));
 end loop;
end $$;

-- Preserve legacy clients, but route their collections through the same balance rules.
create or replace function public.desk_action(action text,target uuid,reason text default '',payment_method text default '',transaction_id text default null)
returns void language plpgsql security definer set search_path=public as $$
declare p payments; b bills; received bigint; actor uuid:=app_actor_id(); begin
 perform gate_lock();
 if action='reverse' then
  if public.current_role()<>'super_admin' or length(trim(reason))<3 then raise exception 'Admin and reversal reason required'; end if;
  select * into p from payments where id=target and not is_archived and source<>'reversal';
  if p.id is null then raise exception 'Payment not found'; end if;
  if exists(select 1 from payments where reversal_of=target) then return; end if;
  select * into b from bills where id=p.bill_id for update;
  insert into payments(bill_id,amount_paise,method,transaction_id,payer,collection_id,recorded_by,source,reversal_of,reason)
  values(b.id,-p.amount_paise,p.method,p.transaction_id,p.payer,p.collection_id,actor,'reversal',target,trim(reason));
  select coalesce(sum(amount_paise),0) into received from payments where bill_id=b.id and not is_archived;
  update bills set status=case when received=amount_paise then 'paid' else 'ready' end,paid_at=case when received=amount_paise then paid_at end,paid_by=case when received=amount_paise then paid_by end where id=b.id;
  insert into audit_events(actor_id,bill_id,action,detail) values(actor,b.id,'reverse',jsonb_build_object('target',target,'reason',reason));
 elsif action in ('collect','approve') then
  if public.current_role()<>'cashier' then raise exception 'Cashier role required'; end if;
  select * into b from bills where id=target for update;
  if b.id is null or b.amount_paise is null or b.invoice_date is null or nullif(trim(b.invoice_reference),'') is null
   or not exists(select 1 from uploads where id=b.upload_id and confirmed_at is not null) then raise exception 'Readable submitted invoice required'; end if;
  if action='collect' then
   if b.settlement_id is not null then raise exception 'Use the settlement collection form'; end if;
   received:=bill_payer_balance(b.id,'customer');
   if received=0 and b.approval_status='approved' then return; end if;
   if b.amount_paise=0 then update bills set approval_status='approved',approved_by=actor,approved_at=now(),status='paid',paid_by=actor,paid_at=now() where id=b.id; return; end if;
   perform app_settle_bills(actor,gen_random_uuid(),jsonb_build_object('action','collect_batch','entries',jsonb_build_array(jsonb_build_object('billId',target,'amountPaise',received)),'payer','customer','method',payment_method,'transactionId',transaction_id));
  else update bills set approval_status='approved',approved_at=coalesce(approved_at,now()),approved_by=coalesce(approved_by,actor) where id=b.id; end if;
 else raise exception 'Unknown operation'; end if;
end $$;

alter function public.desk_snapshot() rename to desk_snapshot_before_settlements;
create function public.desk_snapshot() returns jsonb language sql stable security definer set search_path=public as $$
 select old || jsonb_build_object('bills',coalesce((select jsonb_agg(b || jsonb_build_object('settlement',(select to_jsonb(s) from settlement_cases s where s.id=(b->>'settlement_id')::uuid),'gate_completed',exists(select 1 from gate_pass_bills gb join gate_passes gp on gp.id=gb.pass_id where gb.bill_id=(b->>'id')::uuid and gp.status='used'))) from jsonb_array_elements(old->'bills') b),'[]'))
 from (select desk_snapshot_before_settlements() old) snapshot
$$;
create or replace function public.gate_bills(customer uuid,registration text)
returns table(id uuid,reference text,cleared boolean,completed boolean) language sql stable set search_path=public as $$
 select b.id,coalesce(nullif(b.invoice_reference,''),b.id::text),
 case when b.amount_paise is null and b.field_confidence->'document'->>'kind' in ('warranty_note','amc_note') and b.amount_evidence like 'No monetary total stated;%' then true
 else coalesce(b.amount_paise is not null and b.approval_status='approved' and
 (bill_payer_balance(b.id,'customer')+bill_payer_balance(b.id,'insurer')=0 or
 (not s.revoked and ((s.kind='insurance' and bill_payer_balance(b.id,'customer')=0) or
 (s.kind='credit' and bill_payer_balance(b.id,'customer')<=b.credit_limit_paise)))),false) end,
 exists(select 1 from gate_pass_bills gb join gate_passes gp on gp.id=gb.pass_id where gb.bill_id=b.id and gp.status='used')
 from bills b join uploads u on u.id=b.upload_id left join settlement_cases s on s.id=b.settlement_id
 where b.customer_id=customer and gate_vehicle(b.vehicle_no_display)=registration and u.confirmed_at is not null
$$;
create function public.gate_revoke_settlement() returns trigger language plpgsql security definer set search_path=public as $$ begin
 if new.revoked and not old.revoked then
 update gate_passes set status='revoked' where status='active' and id in
 (select gb.pass_id from gate_pass_bills gb join bills b on b.id=gb.bill_id where b.settlement_id=new.id);
 end if; return null;
end $$;
create trigger gate_settlement_revoked after update on public.settlement_cases for each row execute function public.gate_revoke_settlement();

drop trigger gate_payment_changed on public.payments;
create trigger gate_payment_changed after update of bill_id,amount_paise,is_archived,source,reversal_of,payer on public.payments
for each row execute function public.gate_revoke_payment();

-- Tokens are optional even when an older client passes the retired branch setting.
alter function public.app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean) rename to app_confirm_upload_before_optional_tokens;
create function public.app_confirm_upload(staff uuid,target uuid,tokens jsonb default '{}',contacts jsonb default '{}',require_token boolean default false)
returns public.uploads language sql security definer set search_path=public as $$
 select app_confirm_upload_before_optional_tokens(staff,target,tokens,contacts,false)
$$;
do $$ declare f regprocedure; begin
 foreach f in array array['public.bill_payer_balance(uuid,text)'::regprocedure,'public.app_settle_bills(uuid,uuid,jsonb)'::regprocedure,
 'public.desk_snapshot()'::regprocedure,'public.desk_snapshot_before_settlements()'::regprocedure,
 'public.gate_revoke_settlement()'::regprocedure,'public.app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean)'::regprocedure,
 'public.app_confirm_upload_before_optional_tokens(uuid,uuid,jsonb,jsonb,boolean)'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
