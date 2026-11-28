begin;
alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check check(role in ('cashier','service_advisor','super_admin','security','team_leader'));
create unique index one_active_team_leader on profiles(role) where role='team_leader' and active;
alter table bills add column payment_route text check(payment_route in ('ordinary','insurance','credit'));
update bills set payment_route=coalesce((select kind from settlement_cases where id=bills.settlement_id),'ordinary');
alter table settlement_cases
 add column state text not null default 'legacy_approved' check(state in ('draft','pending','returned','approved','legacy_approved','revoked')),
 add column revision integer not null default 1,
 add column advisor_name text,
 add column approved_by uuid references profiles(id) on delete set null,
 add column approved_name text,
 add column approved_at timestamptz,
 add column acknowledged_at timestamptz,
 add column return_reason text,
 add column proposal jsonb not null default '[]',
 add column submitted_snapshot jsonb,
 add column approved_snapshot jsonb,
 add column followups jsonb not null default '[]';
update settlement_cases set state=case when s.revoked then 'revoked' else 'legacy_approved' end,
 advisor_name=(select full_name from profiles where id=s.recorded_by),
 followups=(select coalesce(jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'actorName','Legacy record','createdAt',s.created_at,'contact',coalesce(s.details->>'contactPerson',''),'note',v,'nextDate','','promisedDate','')),'[]') from unnest(array[s.details->>'followup1',s.details->>'followup2']) v where nullif(trim(v),'') is not null)
 from settlement_cases s where s.id=settlement_cases.id;
alter table settlement_cases alter column state set default 'draft';

create function public.case_approved(target uuid) returns boolean language sql stable set search_path=public as $$
 select target is null or exists(select 1 from settlement_cases where id=target and not revoked and state in ('approved','legacy_approved'))
$$;
create function public.validate_approval(target uuid) returns void language plpgsql set search_path=public as $$
declare s settlement_cases; b bills; e jsonb; amount bigint; n integer; begin
 select * into s from settlement_cases where id=target;
 if s.id is null then raise exception 'Request not found'; end if;
 if nullif(trim(s.details->>'contactPerson'),'') is null or coalesce(s.details->>'contactNumber','') !~ '^\+?[0-9 ()-]{7,40}$'
 or nullif(s.details->>'dueDate','') is null or (s.details->>'dueDate') !~ '^\d{4}-\d{2}-\d{2}$'
 then raise exception 'Contact and due date required'; end if;
 if (s.details->>'dueDate')::date < (now() at time zone 'Asia/Kolkata')::date then raise exception 'Choose a current or future due date'; end if;
 if not exists(select 1 from profiles where id=(s.details->>'responsibleStaffId')::uuid and role='service_advisor' and active) then raise exception 'Choose an active responsible advisor'; end if;
 if s.kind='credit' and nullif(trim(s.details->>'remarks'),'') is null then raise exception 'Credit reason required'; end if;
 if s.kind='insurance' and nullif(trim(s.details->>'insurer'),'') is null then raise exception 'Insurer name required'; end if;
 select count(*) into n from bills where settlement_id=s.id;
 if n=0 or n<>jsonb_array_length(s.proposal) then raise exception 'Select bills for this request'; end if;
 for b in select * from bills where settlement_id=s.id loop
  if b.amount_paise is null or b.invoice_date is null or nullif(trim(b.invoice_reference),'') is null then raise exception 'Readable invoice total, date and number required'; end if;
  select value into e from jsonb_array_elements(s.proposal) where value->>'billId'=b.id::text;
  if e is null then raise exception 'Request bill mismatch'; end if;
  if jsonb_typeof(e->case when s.kind='insurance' then 'insurerPaise' else 'creditPaise' end) is distinct from 'number' then raise exception 'Requested amount required'; end if;
  if (e->>case when s.kind='insurance' then 'insurerPaise' else 'creditPaise' end)::numeric<>trunc((e->>case when s.kind='insurance' then 'insurerPaise' else 'creditPaise' end)::numeric) then raise exception 'Invalid requested amount'; end if;
  amount:=(e->>case when s.kind='insurance' then 'insurerPaise' else 'creditPaise' end)::bigint;
  if amount<0 or amount>b.amount_paise then raise exception 'Requested amount must fit invoice total'; end if;
  if s.kind='insurance' then
   if amount<(select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and not is_archived and payer='insurer')
   or b.amount_paise-amount<(select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and not is_archived and payer='customer') then raise exception 'Split must cover existing receipts'; end if;
  elsif amount>b.amount_paise-(select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and not is_archived)
   or (select coalesce(sum(amount_paise),0) from payments where bill_id=b.id and not is_archived and payer='insurer')<>0 then raise exception 'Credit must fit outstanding customer balance'; end if;
 end loop;
end $$;

create function public.app_approval_action(staff uuid,request_id uuid,payload jsonb) returns void
language plpgsql security definer set search_path=public as $$
#variable_conflict use_column
declare op text:=payload->>'action'; actor profiles; s settlement_cases; old_s settlement_cases; b bills; first_bill bills;
 ids uuid[]; case_id uuid; entry jsonb; form jsonb:=coalesce(payload->'details','{}'); prior desk_operations; f jsonb; responsible profiles; amount numeric;
begin
 perform gate_lock(); perform app_set_actor(staff);
 select * into actor from profiles where id=staff;
 if request_id is null then raise exception 'Request reference required'; end if;
 select * into prior from desk_operations where id=request_id;
 if found then if prior.staff_id<>staff or prior.payload<>payload then raise exception 'Request reference already used'; end if; return; end if;
 if op not in ('save_request','submit_request','approve_request','return_request','acknowledge_request','add_followup','set_bill_route') or op is null then raise exception 'Unknown approval action'; end if;
 if jsonb_typeof(form)<>'object' or length(form::text)>12000 or length(payload::text)>60000 then raise exception 'Invalid form details'; end if;
 case_id:=nullif(payload->>'settlementId','')::uuid;
 if case_id is not null then
  select * into s from settlement_cases where id=case_id for update;
  if s.id is null then raise exception 'Request not found'; end if;
  if (payload->>'revision')::integer is distinct from s.revision then raise exception 'Request changed. Refresh before continuing.'; end if;
 end if;
 old_s:=s;
 if op='set_bill_route' then
  select * into b from bills where id=(payload->>'target')::uuid for update;
  if actor.role<>'service_advisor' or b.id is null or b.uploaded_by is distinct from staff or b.settlement_id is not null
   or exists(select 1 from uploads where id=b.upload_id and confirmed_at is not null) then raise exception 'Only your unsubmitted ordinary bill can be classified'; end if;
  update bills set payment_route='ordinary' where id=b.id;
  ids:=array[b.id];
 elsif op in ('save_request','approve_request') then
  if op='save_request' and (actor.role<>'service_advisor' or (s.id is not null and (s.recorded_by is distinct from staff or s.state not in ('draft','returned') or s.revoked))) then raise exception 'Advisor draft required'; end if;
  if op='approve_request' and (actor.role<>'team_leader' or s.id is null or s.state<>'pending' or s.revoked) then raise exception 'Pending request and Team Leader required'; end if;
  if payload->>'kind' not in ('insurance','credit') or payload->>'kind' is null then raise exception 'Select insurance or credit'; end if;
  if jsonb_typeof(payload->'entries') is distinct from 'array' or jsonb_array_length(payload->'entries') not between 1 and 100 then raise exception 'Select between 1 and 100 bills'; end if;
  select array_agg((value->>'billId')::uuid) into ids from jsonb_array_elements(payload->'entries');
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'Duplicate bill'; end if;
  if s.id is not null and (s.kind<>payload->>'kind' or cardinality(ids)<>(select count(*) from bills where settlement_id=s.id) or exists(select 1 from bills where settlement_id=s.id and not(id=any(ids)))) then raise exception 'Request bill selection is locked'; end if;
  select * into first_bill from bills where id=ids[1];
  for entry in select value from jsonb_array_elements(payload->'entries') loop
   select * into b from bills where id=(entry->>'billId')::uuid for update;
   if b.id is null or (op='save_request' and b.uploaded_by is distinct from staff) or b.amount_paise is null
    or exists(select 1 from gate_pass_bills gb join gate_passes gp on gp.id=gb.pass_id where gb.bill_id=b.id and gp.status='used')
    then raise exception 'Select your readable available invoices'; end if;
   if b.customer_id is distinct from first_bill.customer_id or (b.id<>first_bill.id and (b.customer_id is null or gate_vehicle(first_bill.vehicle_no_display)='' or gate_vehicle(b.vehicle_no_display)<>gate_vehicle(first_bill.vehicle_no_display))) then raise exception 'Select one customer and vehicle'; end if;
   if b.settlement_id is not null and b.settlement_id is distinct from s.id and exists(select 1 from settlement_cases where id=b.settlement_id and not revoked) then raise exception 'Correct the existing request first'; end if;
   if s.id is null and b.settlement_id is null and exists(select 1 from payments where bill_id=b.id and not is_archived) then raise exception 'Correct existing collections before starting a request'; end if;
   if jsonb_typeof(entry->case when payload->>'kind'='insurance' then 'insurerPaise' else 'creditPaise' end) is distinct from 'number' then raise exception 'Requested amount required'; end if;
   amount:=(entry->>case when payload->>'kind'='insurance' then 'insurerPaise' else 'creditPaise' end)::numeric;
   if amount<>trunc(amount) or amount<0 or amount>b.amount_paise then raise exception 'Invalid requested amount'; end if;
  end loop;
  select * into responsible from profiles where id=(form->>'responsibleStaffId')::uuid and role='service_advisor' and active;
  if responsible.id is null then raise exception 'Choose an active responsible advisor'; end if;
  -- Approval identity is exclusively server-derived; clients cannot submit signature fields.
  form:=jsonb_build_object('insurer',form->>'insurer','contactPerson',form->>'contactPerson','contactNumber',form->>'contactNumber',
   'responsibleStaffId',responsible.id,'responsibleStaff',responsible.full_name,'dueDate',form->>'dueDate','remarks',form->>'remarks');
  if s.id is null then
   insert into settlement_cases(id,kind,details,recorded_by,advisor_name,state,proposal)
    values(request_id,payload->>'kind',form,staff,actor.full_name,'draft',payload->'entries') returning * into s;
   update bills set settlement_id=s.id,payment_route=s.kind where id=any(ids);
  else
   update settlement_cases set details=form,proposal=payload->'entries',revision=revision+1,state=case when op='save_request' then 'draft' else state end where id=s.id returning * into s;
  end if;
  if op='approve_request' then
   perform validate_approval(s.id);
   if exists(select 1 from bills b join uploads u on u.id=b.upload_id where b.settlement_id=s.id and u.confirmed_at is null) then raise exception 'Submit all uploads first'; end if;
   update settlement_cases set state='approved',approved_by=staff,approved_name=actor.full_name,approved_at=clock_timestamp(),
    approved_snapshot=jsonb_build_object('details',details,'entries',proposal,'bills',(select jsonb_agg(to_jsonb(b)) from bills b where settlement_id=s.id)) where id=s.id;
   update bills b set customer_share_paise=case when s.kind='insurance' then b.amount_paise-(e->>'insurerPaise')::bigint else null end,
    credit_limit_paise=case when s.kind='credit' then (e->>'creditPaise')::bigint else null end
    from jsonb_array_elements(s.proposal) e where b.id=(e->>'billId')::uuid;
  end if;
 else
  if s.id is null then raise exception 'Request not found'; end if;
  select array_agg(id) into ids from bills where settlement_id=s.id;
  if op='submit_request' then
   if actor.role<>'service_advisor' or s.recorded_by is distinct from staff or s.state not in ('draft','returned') or s.revoked then raise exception 'Advisor draft required'; end if;
   if exists(select 1 from bills b join uploads u on u.id=b.upload_id where b.settlement_id=s.id and u.confirmed_at is null) then raise exception 'Submit all uploads first'; end if;
   perform validate_approval(s.id);
   update settlement_cases set state='pending',submitted_snapshot=jsonb_build_object('details',details,'entries',proposal),revision=revision+1 where id=s.id;
  elsif op='return_request' then
   if actor.role<>'team_leader' or s.state<>'pending' or s.revoked then raise exception 'Pending request and Team Leader required'; end if;
   if nullif(trim(payload->>'reason'),'') is null then raise exception 'Return reason required'; end if;
   update settlement_cases set state='returned',return_reason=payload->>'reason',revision=revision+1 where id=s.id;
  elsif op='acknowledge_request' then
   if actor.role<>'cashier' or not case_approved(s.id) then raise exception 'TL approval and cashier required'; end if;
   update settlement_cases set acknowledged_at=coalesce(acknowledged_at,clock_timestamp()),revision=revision+1 where id=s.id;
   update bills set approval_status='approved',approved_by=coalesce(approved_by,staff),approved_at=coalesce(approved_at,clock_timestamp()) where settlement_id=s.id;
  elsif op='add_followup' then
   if actor.role<>'team_leader' or not case_approved(s.id) then raise exception 'Approved case and Team Leader required'; end if;
   f:=payload->'followup';
   if jsonb_typeof(f) is distinct from 'object' or length(f::text)>4000 or nullif(trim(f->>'contact'),'') is null or nullif(trim(f->>'note'),'') is null then raise exception 'Contact and follow-up note required'; end if;
   if nullif(f->>'nextDate','') is not null then perform (f->>'nextDate')::date; end if;
   if nullif(f->>'promisedDate','') is not null then perform (f->>'promisedDate')::date; end if;
   f:=jsonb_build_object('contact',f->>'contact','note',f->>'note','nextDate',f->>'nextDate','promisedDate',f->>'promisedDate','actorName',actor.full_name,'createdAt',clock_timestamp(),'id',request_id);
   update settlement_cases set followups=followups || jsonb_build_array(f),revision=revision+1 where id=s.id;
  end if;
 end if;
 insert into desk_operations(id,staff_id,payload) values(request_id,staff,payload);
 insert into audit_events(actor_id,bill_id,action,detail) select staff,id,op,jsonb_build_object('requestId',request_id,'before',to_jsonb(old_s),'request',payload,'after',(select to_jsonb(sc) from settlement_cases sc where sc.id=s.id)) from unnest(ids) id;
end $$;

-- Old clients cannot create approvals or edit signed terms.
alter function app_settle_bills(uuid,uuid,jsonb) rename to app_settle_bills_before_tl;
create function app_settle_bills(staff uuid,request_id uuid,payload jsonb) returns void language plpgsql security definer set search_path=public as $$
declare e jsonb; begin
 perform gate_lock(); perform app_set_actor(staff);
 if payload->>'action' in ('arrange','update_settlement') then raise exception 'Refresh the workspace: advisors prepare requests and the TL approves them'; end if;
 if payload->>'action'='collect_batch' then
  for e in select value from jsonb_array_elements(payload->'entries') loop
   if exists(select 1 from bills where id=(e->>'billId')::uuid and not case_approved(settlement_id)) then raise exception 'TL approval required'; end if;
  end loop;
 end if;
 perform app_settle_bills_before_tl(staff,request_id,payload);
 if payload->>'action'='revoke_settlement' then update settlement_cases set state='revoked',revision=revision+1 where id=(payload->>'settlementId')::uuid; end if;
end $$;
alter function desk_action(text,uuid,text,text,text) rename to desk_action_before_tl;
create function desk_action(action text,target uuid,reason text default '',payment_method text default '',transaction_id text default null) returns void language plpgsql security definer set search_path=public as $$ begin
 perform gate_lock();
 if action in ('approve','collect') and exists(select 1 from bills where id=target and not case_approved(settlement_id)) then raise exception 'TL approval required'; end if;
 perform desk_action_before_tl(action,target,reason,payment_method,transaction_id);
end $$;

-- Classification is persisted before upload confirmation. Draft requests stay out of the cashier queue.
alter function app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean) rename to app_confirm_upload_before_tl;
create function app_confirm_upload(staff uuid,target uuid,tokens jsonb default '{}',contacts jsonb default '{}',require_token boolean default false)
returns uploads language plpgsql security definer set search_path=public as $$
declare result uploads; s settlement_cases; begin
 perform gate_lock(); perform app_set_actor(staff);
 if public.current_role()<>'service_advisor' then raise exception 'Service advisor role required'; end if;
 update bills set payment_route='ordinary' where upload_id=target and uploaded_by=staff and amount_paise is null and field_confidence->'document'->>'kind' in ('warranty_note','amc_note') and amount_evidence like 'No monetary total stated;%';
 if exists(select 1 from bills where upload_id=target and payment_route is null) then raise exception 'Choose ordinary payment, insurance or credit for every invoice before submitting'; end if;
 for s in select distinct sc.* from settlement_cases sc join bills b on b.settlement_id=sc.id where b.upload_id=target and sc.state in ('draft','returned') loop perform validate_approval(s.id); end loop;
 result:=app_confirm_upload_before_tl(staff,target,tokens,contacts,require_token);
 for s in select distinct sc.* from settlement_cases sc join bills b on b.settlement_id=sc.id where b.upload_id=target and sc.state in ('draft','returned') loop
  if not exists(select 1 from bills b join uploads u on u.id=b.upload_id where b.settlement_id=s.id and u.confirmed_at is null) then
   perform app_approval_action(staff,gen_random_uuid(),jsonb_build_object('action','submit_request','settlementId',s.id,'revision',s.revision));
  end if;
 end loop;
 return result;
end $$;

create or replace function desk_snapshot() returns jsonb language sql stable security definer set search_path=public as $$
 with visible as (
 select b.* from bills b join uploads u on u.id=b.upload_id left join settlement_cases s on s.id=b.settlement_id
 where public.current_role()='super_admin' or (public.current_role()='service_advisor' and b.uploaded_by=app_actor_id())
 or (public.current_role()='cashier' and u.confirmed_at is not null and case_approved(b.settlement_id))
 or (public.current_role()='team_leader' and u.confirmed_at is not null and s.state<>'draft')
 ) select jsonb_build_object('as_of',now(),
 'bills',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('settlement',(select to_jsonb(s) from settlement_cases s where s.id=b.settlement_id),
 'gate_completed',exists(select 1 from gate_pass_bills gb join gate_passes gp on gp.id=gb.pass_id where gb.bill_id=b.id and gp.status='used'),
 'uploads',jsonb_build_object('original_filename',u.original_filename,'confirmed_at',u.confirmed_at,'file_hash',u.file_hash)) order by b.created_at desc) from visible b join uploads u on u.id=b.upload_id),'[]'),
 'payments',coalesce((select jsonb_agg(p order by p.occurred_at desc) from payments p where bill_id in(select id from visible)),'[]'),
 'audit',coalesce((select jsonb_agg(a order by a.created_at desc) from audit_events a where public.current_role()='super_admin' or bill_id in(select id from visible)),'[]'),
 'staff',coalesce((select jsonb_agg(p) from profiles p where public.current_role() in ('super_admin','cashier','team_leader') or (public.current_role()='service_advisor' and (p.id=app_actor_id() or p.role in ('service_advisor','team_leader')))),'[]'))
$$;

alter function gate_bills(uuid,text) rename to gate_bills_before_tl;
create function gate_bills(customer uuid,registration text) returns table(id uuid,reference text,cleared boolean,completed boolean) language sql stable set search_path=public as $$
 select g.id,g.reference,g.cleared and case_approved(b.settlement_id) and (s.id is null or s.state='legacy_approved' or s.acknowledged_at is not null),g.completed
 from gate_bills_before_tl(customer,registration) g join bills b on b.id=g.id left join settlement_cases s on s.id=b.settlement_id
$$;

-- Keep internal pre-migration implementations inaccessible through PostgREST.
do $$ declare f regprocedure; begin
 foreach f in array array['case_approved(uuid)'::regprocedure,'validate_approval(uuid)'::regprocedure,'app_approval_action(uuid,uuid,jsonb)'::regprocedure,
 'app_settle_bills(uuid,uuid,jsonb)'::regprocedure,'app_settle_bills_before_tl(uuid,uuid,jsonb)'::regprocedure,'desk_action(text,uuid,text,text,text)'::regprocedure,
 'desk_action_before_tl(text,uuid,text,text,text)'::regprocedure,'app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean)'::regprocedure,
 'app_confirm_upload_before_tl(uuid,uuid,jsonb,jsonb,boolean)'::regprocedure,'gate_bills(uuid,text)'::regprocedure,'gate_bills_before_tl(uuid,text)'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end $$;
grant execute on function app_approval_action(uuid,uuid,jsonb),app_settle_bills(uuid,uuid,jsonb),app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean) to service_role;
notify pgrst,'reload schema';
commit;
