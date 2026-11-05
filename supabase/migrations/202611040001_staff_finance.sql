-- Permanent history; deploy this migration before the new application.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('cashier','service_advisor','super_admin'));
alter table public.profiles add column staff_id text unique;
alter table public.profiles add column active boolean not null default true;
alter table public.profiles add column must_change_password boolean not null default true;
update public.profiles set staff_id = 'staff_' || replace(id::text, '-', '') where staff_id is null;
alter table public.profiles alter column staff_id set not null;
alter table public.profiles add constraint staff_id_format check (staff_id ~ '^[a-z0-9_]{3,40}$');
alter table public.bills add column invoice_date date;
alter table public.bills add column amount_paise bigint check (amount_paise between 0 and 100000000000);
alter table public.bills add column approval_status text not null default 'pending' check (approval_status in ('pending','approved'));
alter table public.bills add column approved_at timestamptz;
alter table public.bills add column approved_by uuid references public.profiles(id);
alter table public.bills add column amount_evidence text not null default '';
alter table public.bills add column payment_evidence jsonb not null default '[]';
alter table public.bills add column extraction_issues jsonb not null default '["Historical record: re-extract financial data from the original PDF."]';
alter table public.bills drop constraint bills_check1;
update public.bills set delete_after = null;
alter table public.bills add constraint no_expiry check (delete_after is null);
create unique index approved_invoice_unique on public.bills (upper(trim(invoice_reference))) where approval_status = 'approved';
create index bills_invoice_date on public.bills(invoice_date);
create table public.payments (
 id uuid primary key default gen_random_uuid(), bill_id uuid not null references public.bills(id) on delete restrict,
 amount_paise bigint not null check (amount_paise <> 0), method text not null default 'not stated',
 occurred_at timestamptz not null default now(), recorded_at timestamptz not null default now(),
 recorded_by uuid not null references public.profiles(id), source text not null check (source in ('document','cashier','reversal')),
 reversal_of uuid unique references public.payments(id), reason text,
 check ((source = 'reversal' and amount_paise < 0 and reversal_of is not null and length(trim(reason)) > 0)
 or (source <> 'reversal' and amount_paise > 0 and reversal_of is null))
);
create index payments_bill on public.payments(bill_id);
create index payments_occurred on public.payments(occurred_at);
create table public.audit_events (
 id uuid primary key default gen_random_uuid(), bill_id uuid references public.bills(id) on delete restrict,
 actor_id uuid not null references public.profiles(id), action text not null,
 detail jsonb not null default '{}', created_at timestamptz not null default now()
);
alter table public.payments enable row level security;
alter table public.audit_events enable row level security;
create or replace function public.current_role() returns text language sql stable security definer set search_path = public as $$
 select role from public.profiles where id = auth.uid() and active and not must_change_password
$$;
do $$ declare p record; begin
 for p in select tablename, policyname from pg_policies where schemaname = 'public'
 and tablename in ('profiles','uploads','bills','bill_edit_log','purge_runs')
 loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy self_profile on public.profiles for select using (id = auth.uid());
create policy visible_uploads on public.uploads for select using (
 public.current_role() = 'super_admin' or (public.current_role() = 'cashier' and confirmed_at is not null)
 or (public.current_role() = 'service_advisor' and uploaded_by = auth.uid()));
create policy visible_bills on public.bills for select using (
 public.current_role() = 'super_admin'
 or (public.current_role() = 'cashier' and exists(select 1 from public.uploads u where u.id = upload_id and u.confirmed_at is not null))
 or (public.current_role() = 'service_advisor' and uploaded_by = auth.uid()));
create policy visible_payments on public.payments for select using (exists(select 1 from public.bills b where b.id = bill_id));
create policy visible_audit on public.audit_events for select using (
 public.current_role() = 'super_admin' or exists(select 1 from public.bills b where b.id = bill_id));
drop policy if exists "advisors read own pdfs" on storage.objects;
drop policy if exists "cashiers read bill pdfs" on storage.objects;
create policy staff_read_pdfs on storage.objects for select to authenticated using (
 bucket_id = 'bills' and exists(select 1 from public.uploads u where u.storage_path = name));
create or replace function public.mark_bills_paid(target_ids uuid[]) returns setof public.bills
language plpgsql as $$ begin raise exception 'Use the approved bill collection workflow'; end $$;
create or replace function public.undo_payment(target_ids uuid[] default null, target_batch uuid default null) returns setof public.bills
language plpgsql as $$ begin raise exception 'Use an audited administrator reversal'; end $$;
create or replace function public.desk_action(action text, target uuid, reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare r text := public.current_role(); b public.bills; p public.payments; e jsonb; received bigint; remainder bigint;
begin
 if r is null then raise exception 'Active staff login required'; end if;
 if action = 'reverse' then
  if r <> 'super_admin' or length(trim(reason)) < 3 then raise exception 'Admin and reversal reason required'; end if;
  select * into p from public.payments where id = target;
  if not found or p.source = 'reversal' then raise exception 'Payment not found'; end if;
  select * into b from public.bills where id = p.bill_id for update;
  if exists(select 1 from public.payments where reversal_of = target) then return; end if;
  insert into public.payments(bill_id,amount_paise,method,recorded_by,source,reversal_of,reason)
   values(b.id,-p.amount_paise,p.method,auth.uid(),'reversal',target,trim(reason));
 else
  if r <> 'cashier' then raise exception 'Cashier role required'; end if;
  select * into b from public.bills where id = target for update;
  if not found or not exists(select 1 from public.uploads where id = b.upload_id and confirmed_at is not null) then raise exception 'Submitted bill required'; end if;
  if action = 'approve' then
   if b.approval_status = 'approved' then return; end if;
   if b.amount_paise is null or b.invoice_date is null or nullif(trim(b.invoice_reference),'') is null then
    raise exception 'Readable invoice total, date and invoice number required. Request a corrected PDF.';
   end if;
   update public.bills set approval_status = 'approved', approved_at = now(), approved_by = auth.uid() where id = b.id;
   for e in select * from jsonb_array_elements(b.payment_evidence) loop
    insert into public.payments(bill_id,amount_paise,method,occurred_at,recorded_by,source)
    values(b.id,(e->>'amount_paise')::bigint,e->>'method',((e->>'date')::date::timestamp at time zone 'Asia/Kolkata'),auth.uid(),'document');
   end loop;
  elsif action = 'collect' then
   if b.approval_status <> 'approved' then raise exception 'Approve this bill first'; end if;
   select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id;
   remainder := b.amount_paise - received;
   if remainder <= 0 then return; end if;
   insert into public.payments(bill_id,amount_paise,recorded_by,source) values(b.id,remainder,auth.uid(),'cashier');
  else raise exception 'Unknown operation'; end if;
 end if;
 select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id;
 if received > b.amount_paise or received < 0 then raise exception 'Payments do not reconcile'; end if;
 update public.bills set status = case when received = amount_paise then 'paid' else 'ready' end,
 paid_at = case when received = amount_paise then now() else null end,
 paid_by = case when received = amount_paise then auth.uid() else null end, delete_after = null where id = b.id;
 insert into public.audit_events(bill_id,actor_id,action,detail)
 values(b.id,auth.uid(),action,jsonb_build_object('target',target,'reason',reason));
end $$;
revoke all on function public.desk_action(text,uuid,text) from public, anon;
grant execute on function public.desk_action(text,uuid,text) to authenticated;
create or replace function public.desk_snapshot() returns jsonb
language sql stable security definer set search_path = public as $$
with visible as (
 select b.* from public.bills b join public.uploads u on u.id = b.upload_id
 where public.current_role() = 'super_admin'
 or (public.current_role() = 'cashier' and u.confirmed_at is not null)
 or (public.current_role() = 'service_advisor' and b.uploaded_by = auth.uid())
)
select jsonb_build_object('as_of',now(),
 'bills',coalesce((select jsonb_agg(to_jsonb(b) || jsonb_build_object('uploads',
 jsonb_build_object('original_filename',u.original_filename,'confirmed_at',u.confirmed_at,'file_hash',u.file_hash)) order by b.created_at desc)
 from visible b join public.uploads u on u.id = b.upload_id),'[]'),
 'payments',coalesce((select jsonb_agg(p order by p.occurred_at desc) from public.payments p where bill_id in (select id from visible)),'[]'),
 'audit',coalesce((select jsonb_agg(a order by a.created_at desc) from public.audit_events a where public.current_role() = 'super_admin' or bill_id in (select id from visible)),'[]'),
 'staff',coalesce((select jsonb_agg(p) from public.profiles p where public.current_role() in ('super_admin','cashier') or (public.current_role() = 'service_advisor' and p.id = auth.uid())),'[]'))
$$;
revoke all on function public.desk_snapshot() from public, anon;
grant execute on function public.desk_snapshot() to authenticated;
do $$ declare j record; begin
 if exists(select 1 from pg_extension where extname = 'pg_cron') then
  for j in execute 'select jobid from cron.job where command like ''%purge-paid%''' loop
   execute format('select cron.unschedule(%s)', j.jobid);
  end loop;
 end if;
end $$;
