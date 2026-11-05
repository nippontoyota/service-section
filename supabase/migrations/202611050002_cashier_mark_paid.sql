-- Marking a bill paid approves and collects it atomically under the existing bill lock.
begin;
create or replace function public.desk_action(action text, target uuid, reason text default '')
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
    insert into public.payments(bill_id,amount_paise,recorded_by,source) values(b.id,b.amount_paise,public.app_actor_id(),'cashier');
   end if;
  else raise exception 'Unknown operation'; end if;
 end if;
 select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id and not is_archived;
 if received not in (0,b.amount_paise) then raise exception 'Payments do not reconcile'; end if;
 update public.bills set status = case when received = amount_paise then 'paid' else 'ready' end,
 paid_at = case when received = amount_paise then now() else null end,
 paid_by = case when received = amount_paise then public.app_actor_id() else null end, delete_after = null where id = b.id;
 insert into public.audit_events(bill_id,actor_id,action,detail)
 values(b.id,public.app_actor_id(),action,jsonb_build_object('target',target,'reason',reason));
end $$;
revoke all on function public.desk_action(text,uuid,text) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
