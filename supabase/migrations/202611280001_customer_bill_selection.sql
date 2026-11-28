-- Collect selected bills for one customer across vehicles.
-- Release arrangements remain scoped to one vehicle. Existing locking,
-- idempotency, balances, permissions and atomic writes are preserved.
create or replace function public.app_settle_bills(staff uuid, request_id uuid, payload jsonb) returns void
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
  if b.customer_id is distinct from first_bill.customer_id or (b.id<>first_bill.id and b.customer_id is null) then raise exception 'Select bills for one customer'; end if;
  if op='arrange' and b.id<>first_bill.id and (gate_vehicle(first_bill.vehicle_no_display)='' or gate_vehicle(b.vehicle_no_display)<>gate_vehicle(first_bill.vehicle_no_display)) then raise exception 'Select bills for one customer and vehicle'; end if;
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

