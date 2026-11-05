-- Full-bill settlements and one customer to many invoices.
create table public.customers (
 id uuid primary key default gen_random_uuid(),
 identity_key text not null unique,
 external_reference text,
 display_name text not null,
 created_at timestamptz not null default now()
);
alter table public.customers enable row level security;
alter table public.bills add column customer_reference text;
alter table public.bills add column customer_id uuid references public.customers(id) on delete restrict;
create index bills_customer_id on public.bills(customer_id);
create or replace function public.link_bill_customer()
returns trigger language plpgsql security definer set search_path=public as $$
declare k text; n text; v text; r text;
begin
 n := upper(regexp_replace(coalesce(new.customer_name,''),'[^A-Za-z0-9]','','g'));
 r := upper(regexp_replace(coalesce(new.customer_reference,''),'[^A-Za-z0-9]','','g'));
 v := upper(regexp_replace(coalesce(new.vin,''),'[^A-Za-z0-9]','','g'));
 if r <> '' then k := 'REF:' || r;
 elsif n <> '' and length(v)=17 then k := 'VIN:' || v || ':' || n;
 elsif n <> '' and regexp_replace(coalesce(new.vehicle_no_display,''),'[^A-Za-z0-9]','','g') <> '' then
   k := 'VEHICLE:' || upper(regexp_replace(new.vehicle_no_display,'[^A-Za-z0-9]','','g')) || ':' || n;
 else k := 'UNMATCHED:' || new.id::text;
 end if;
 insert into public.customers(identity_key,external_reference,display_name)
 values(k,nullif(r,''),coalesce(nullif(new.customer_name,''),'Unidentified customer'))
 on conflict(identity_key) do update set identity_key=excluded.identity_key
 returning id into new.customer_id;
 return new;
end $$;
create trigger bills_customer_link before insert or update of customer_reference,customer_name,vin,vehicle_no_display,customer_id
on public.bills for each row execute function public.link_bill_customer();
update public.bills set customer_name=customer_name;
alter table public.bills alter column customer_id set not null;
create policy relevant_customers on public.customers for select using (
 public.current_role() is not null and exists(select 1 from public.bills b where b.customer_id=customers.id)
);

-- Preserve old fragments; never turn a partial payment into a full collection.
alter table public.payments add column is_archived boolean not null default false;
do $$ declare b record; p public.payments; net bigint; begin
 for b in select distinct bills.id,bills.amount_paise,bills.uploaded_by from public.bills bills
 join public.payments old_payment on old_payment.bill_id=bills.id where abs(old_payment.amount_paise)<>bills.amount_paise or bills.amount_paise is null
 loop
   select coalesce(sum(amount_paise),0) into net from public.payments where bill_id=b.id;
   select * into p from public.payments where bill_id=b.id and amount_paise>0 order by occurred_at desc limit 1;
   update public.payments set is_archived=true where bill_id=b.id;
   if net=b.amount_paise and net>0 then
     insert into public.payments(bill_id,amount_paise,recorded_by,source,occurred_at)
     values(b.id,b.amount_paise,p.recorded_by,'cashier',p.occurred_at);
   else
     update public.bills set status='ready',paid_at=null,paid_by=null where id=b.id;
   end if;
   insert into public.audit_events(bill_id,actor_id,action,detail)
   values(b.id,b.uploaded_by,'legacy_payment_history_preserved',
     jsonb_build_object('reason','Full-bill-only transition; original entries retained in payments archive','previous_net_paise',net));
 end loop;
end $$;
update public.bills set payment_evidence='[]';
drop policy visible_payments on public.payments;
create policy visible_payments on public.payments for select using (
 not is_archived and exists(select 1 from public.bills b where b.id=bill_id)
);

create or replace function public.require_full_bill_payment()
returns trigger language plpgsql security definer set search_path=public as $$
declare b public.bills; net bigint;
begin
 if new.is_archived then return new; end if;
 select * into b from public.bills where id=new.bill_id for update;
 if b.approval_status <> 'approved' or b.amount_paise is null or abs(new.amount_paise)<>b.amount_paise then
   raise exception 'Payment must equal the approved invoice total';
 end if;
 select coalesce(sum(amount_paise),0) into net from public.payments where bill_id=b.id and not is_archived;
 if net not in (0,b.amount_paise) then raise exception 'Only unpaid or fully paid bills are supported'; end if;
 return new;
end $$;
create trigger payments_full_bill after insert or update on public.payments
for each row execute function public.require_full_bill_payment();

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
  elsif action = 'collect' then
   if b.approval_status <> 'approved' then raise exception 'Approve this bill first'; end if;
   select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id and not is_archived;
   if received = b.amount_paise then return; end if;
   if received <> 0 then raise exception 'Only full-bill collection is supported'; end if;
   insert into public.payments(bill_id,amount_paise,recorded_by,source) values(b.id,b.amount_paise,auth.uid(),'cashier');
  else raise exception 'Unknown operation'; end if;
 end if;
 select coalesce(sum(amount_paise),0) into received from public.payments where bill_id = b.id and not is_archived;
 if received not in (0,b.amount_paise) then raise exception 'Payments do not reconcile'; end if;
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
 'payments',coalesce((select jsonb_agg(p order by p.occurred_at desc) from public.payments p where not p.is_archived and bill_id in (select id from visible)),'[]'),
 'audit',coalesce((select jsonb_agg(a order by a.created_at desc) from public.audit_events a where public.current_role() = 'super_admin' or bill_id in (select id from visible)),'[]'),
 'staff',coalesce((select jsonb_agg(p) from public.profiles p where public.current_role() in ('super_admin','cashier') or (public.current_role() = 'service_advisor' and p.id = auth.uid())),'[]'))
$$;
revoke all on function public.desk_snapshot() from public, anon;
grant execute on function public.desk_snapshot() to authenticated;
