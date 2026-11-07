-- Apply before deploying the token and payment-method forms.
begin;
alter table public.bills add column token_number text
  check (token_number is null or (length(token_number) between 1 and 30 and token_number = trim(token_number)));

-- Replace signatures so no legacy overload can bypass payment-method validation.
drop function public.app_desk_action(uuid,text,uuid,text);
drop function public.desk_action(text,uuid,text);
drop function public.app_confirm_upload(uuid,uuid);

create or replace function public.desk_action(action text, target uuid, reason text default '', payment_method text default '')
returns void language plpgsql security definer set search_path = public as $$
declare r text := public.current_role(); b public.bills; p public.payments; received bigint;
begin
 if r is null then raise exception 'Active staff login required'; end if;
 if action = 'reverse' then
  if r <> 'super_admin' or length(trim(reason)) < 3 then raise exception 'Admin and reversal reason required'; end if;
  select * into p from public.payments where id = target and not is_archived;
  if not found or p.source = 'reversal' then raise exception 'Payment not found'; end if;
  select * into b from public.bills where id = p.bill_id for update;
  if exists(select 1 from public.payments where reversal_of = target) then return; end if;
  insert into public.payments(bill_id,amount_paise,method,recorded_by,source,reversal_of,reason)
   values(b.id,-p.amount_paise,p.method,public.app_actor_id(),'reversal',target,trim(reason));
 else
  if r <> 'cashier' then raise exception 'Cashier role required'; end if;
  select * into b from public.bills where id = target for update;
  if not found or not exists(select 1 from public.uploads where id = b.upload_id and confirmed_at is not null) then raise exception 'Submitted bill required'; end if;
  if action = 'approve' then
   if b.approval_status = 'approved' then return; end if;
   if b.amount_paise is null or b.invoice_date is null or nullif(trim(b.invoice_reference),'') is null then
    raise exception 'Readable invoice total, date and invoice number required. Request a corrected PDF.';
   end if;
   update public.bills set approval_status = 'approved', approved_at = now(), approved_by = public.app_actor_id() where id = b.id;
  elsif action = 'collect' then
   if payment_method is null or not (
     payment_method in ('Cash','GPay','Cheque','Demand Draft')
     or (left(payment_method,7) = 'Other: ' and length(trim(substring(payment_method from 8))) between 1 and 100)
   ) then raise exception 'Choose a payment method and specify Other when selected'; end if;
   if b.amount_paise is null or b.invoice_date is null or nullif(trim(b.invoice_reference),'') is null then
    raise exception 'Readable invoice total, date and invoice number required. Request a corrected PDF.';
   end if;
   if b.approval_status <> 'approved' then
    update public.bills set approval_status = 'approved', approved_at = now(), approved_by = public.app_actor_id() where id = b.id;
   end if;
   select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id and not is_archived;
   if received = b.amount_paise and b.approval_status = 'approved' then return; end if;
   if received <> 0 then raise exception 'Only full-bill collection is supported'; end if;
   if b.amount_paise > 0 then
    insert into public.payments(bill_id,amount_paise,method,recorded_by,source) values(b.id,b.amount_paise,payment_method,public.app_actor_id(),'cashier');
   end if;
  else raise exception 'Unknown operation'; end if;
 end if;
 select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id and not is_archived;
 if received not in (0,b.amount_paise) then raise exception 'Payments do not reconcile'; end if;
 update public.bills set status = case when received = amount_paise then 'paid' else 'ready' end,
 paid_at = case when received = amount_paise then now() else null end,
 paid_by = case when received = amount_paise then public.app_actor_id() else null end, delete_after = null where id = b.id;
 insert into public.audit_events(bill_id,actor_id,action,detail)
 values(b.id,public.app_actor_id(),action,jsonb_build_object('target',target,'reason',reason) || case when action = 'collect' then jsonb_build_object('payment_method',payment_method) else '{}'::jsonb end);
end $$;
revoke all on function public.desk_action(text,uuid,text,text) from public, anon, authenticated;

create function public.app_desk_action(staff uuid, action text, target uuid, reason text default '', payment_method text default '') returns void
language plpgsql security definer set search_path = public as $$ begin
 perform app_set_actor(staff);
 perform desk_action(action,target,reason,payment_method);
end $$;
revoke all on function public.app_desk_action(uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.app_desk_action(uuid,text,uuid,text,text) to service_role;

create function public.app_confirm_upload(staff uuid, target uuid, tokens jsonb default '{}'::jsonb) returns public.uploads
language plpgsql security definer set search_path = public as $$
declare u public.uploads; entry record;
begin
  perform public.app_set_actor(staff);
  if public.current_role() <> 'service_advisor' then
    raise exception 'Service advisor role required' using errcode = '42501';
  end if;

  select * into u from public.uploads where id = target and uploaded_by = staff for update;
  if not found then
    raise exception 'Upload not found' using errcode = 'P0002';
  end if;
  -- A retried request returns its existing result, without another audit entry.
  if u.status = 'confirmed' and u.confirmed_at is not null then return u; end if;
  if u.status <> 'review' or u.confirmed_at is not null
     or u.file_hash is null or u.file_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Upload must finish processing before submission' using errcode = '55000';
  end if;
  if not exists(select 1 from public.bills where upload_id = target) then
    raise exception 'Upload has no extracted bills to submit' using errcode = '55000';
  end if;

  if tokens is null or jsonb_typeof(tokens) <> 'object' then
    raise exception 'Invalid token numbers' using errcode = '22023';
  end if;
  for entry in select * from jsonb_each(tokens) loop
    if jsonb_typeof(entry.value) not in ('string','null')
       or length(trim(entry.value #>> '{}')) > 30
       or not exists(select 1 from public.bills where upload_id = target and id::text = entry.key) then
      raise exception 'Invalid token number or bill' using errcode = '22023';
    end if;
  end loop;
  update public.bills set token_number = nullif(trim(tokens ->> id::text),'')
  where upload_id = target and tokens ? id::text;

  -- The unique index arbitrates simultaneous submissions of the same PDF.
  -- Other file hashes do not share a lock or wait on a global upload queue.
  update public.uploads set status = 'confirmed', confirmed_at = now()
  where id = target returning * into u;

  insert into public.audit_events(bill_id, actor_id, action, detail)
  select id, staff, 'submitted', jsonb_build_object('token_number',token_number) from public.bills where upload_id = target;
  return u;
end;
$$;

revoke all on function public.app_confirm_upload(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.app_confirm_upload(uuid,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
