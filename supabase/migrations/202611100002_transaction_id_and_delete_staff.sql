-- Optional transaction references and permanent staff-account deletion.
begin;
alter table public.payments add column transaction_id text
 check (transaction_id is null or (length(transaction_id) between 1 and 100 and transaction_id = trim(transaction_id)));
drop function public.app_desk_action(uuid,text,uuid,text,text);
drop function public.desk_action(text,uuid,text,text);

create or replace function public.desk_action(action text, target uuid, reason text default '', payment_method text default '', transaction_id text default null)
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
  insert into public.payments(bill_id,amount_paise,method,recorded_by,source,reversal_of,reason,transaction_id)
   values(b.id,-p.amount_paise,p.method,public.app_actor_id(),'reversal',target,trim(reason),p.transaction_id);
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
   if length(trim(transaction_id)) > 100 then raise exception 'Transaction ID must be up to 100 characters'; end if;
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
    insert into public.payments(bill_id,amount_paise,method,recorded_by,source,transaction_id) values(b.id,b.amount_paise,payment_method,public.app_actor_id(),'cashier',nullif(trim(transaction_id),''));
   end if;
  else raise exception 'Unknown operation'; end if;
 end if;
 select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id and not is_archived;
 if received not in (0,b.amount_paise) then raise exception 'Payments do not reconcile'; end if;
 update public.bills set status = case when received = amount_paise then 'paid' else 'ready' end,
 paid_at = case when received = amount_paise then now() else null end,
 paid_by = case when received = amount_paise then public.app_actor_id() else null end, delete_after = null where id = b.id;
 insert into public.audit_events(bill_id,actor_id,action,detail)
 values(b.id,public.app_actor_id(),action,jsonb_build_object('target',target,'reason',reason) || case when action = 'collect' then jsonb_build_object('payment_method',payment_method,'transaction_id',nullif(trim(transaction_id),'')) else '{}'::jsonb end);
end $$;
revoke all on function public.desk_action(text,uuid,text,text,text) from public, anon, authenticated;

create function public.app_desk_action(staff uuid, action text, target uuid, reason text default '', payment_method text default '', transaction_id text default null) returns void
language plpgsql security definer set search_path = public as $$ begin
 perform app_set_actor(staff);
 perform desk_action(action,target,reason,payment_method,transaction_id);
end $$;
revoke all on function public.app_desk_action(uuid,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.app_desk_action(uuid,text,uuid,text,text,text) to service_role;

-- Preserve financial records when a staff profile is permanently removed.
alter table public.uploads
 alter column uploaded_by drop not null,
 drop constraint uploads_uploaded_by_fkey,
 add constraint uploads_uploaded_by_fkey foreign key (uploaded_by) references public.profiles(id) on delete set null;
alter table public.bills
 alter column uploaded_by drop not null,
 drop constraint bills_uploaded_by_fkey,
 add constraint bills_uploaded_by_fkey foreign key (uploaded_by) references public.profiles(id) on delete set null;
alter table public.bills
 alter column paid_by drop not null,
 drop constraint bills_paid_by_fkey,
 add constraint bills_paid_by_fkey foreign key (paid_by) references public.profiles(id) on delete set null;
alter table public.bills
 alter column approved_by drop not null,
 drop constraint bills_approved_by_fkey,
 add constraint bills_approved_by_fkey foreign key (approved_by) references public.profiles(id) on delete set null;
alter table public.payments
 alter column recorded_by drop not null,
 drop constraint payments_recorded_by_fkey,
 add constraint payments_recorded_by_fkey foreign key (recorded_by) references public.profiles(id) on delete set null;
alter table public.audit_events
 alter column actor_id drop not null,
 drop constraint audit_events_actor_id_fkey,
 add constraint audit_events_actor_id_fkey foreign key (actor_id) references public.profiles(id) on delete set null;
alter table public.bill_edit_log
 alter column changed_by drop not null,
 drop constraint bill_edit_log_changed_by_fkey,
 add constraint bill_edit_log_changed_by_fkey foreign key (changed_by) references public.profiles(id) on delete set null;

create function public.app_delete_staff(actor uuid, target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a profiles; account profiles;
begin
 select * into a from profiles where id=actor and active and not must_change_password for update;
 if not found or a.role <> 'super_admin' then raise exception 'Super admin role required'; end if;
 select * into account from profiles where id=target for update;
 if not found then raise exception 'Staff account not found'; end if;
 if target = actor or account.staff_id = 'admin01' then raise exception 'This account cannot be deleted'; end if;
 -- Credentials and sessions cascade; historical staff references become null.
 delete from staff_login_attempts where login_id=account.staff_id;
 delete from profiles where id=target;
 insert into audit_events(actor_id,action,detail)
 values(actor,'delete_staff',jsonb_build_object('target',target,'staff_id',account.staff_id));
end $$;
revoke all on function public.app_delete_staff(uuid,uuid) from public, anon, authenticated;
grant execute on function public.app_delete_staff(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
