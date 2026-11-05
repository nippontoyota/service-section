create extension if not exists pg_trgm;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('service_advisor', 'cashier')),
  created_at timestamptz not null default now()
);

create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references public.profiles(id),
  storage_path text not null unique,
  original_filename text not null,
  file_hash text,
  page_count integer check (page_count between 1 and 100),
  status text not null default 'uploading' check (status in ('uploading', 'processing', 'review', 'confirmed', 'failed')),
  processing_error text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.uploads(id) on delete cascade,
  page_from integer not null check (page_from > 0),
  page_to integer not null check (page_to >= page_from),
  connection_key text not null,
  connection_key_type text not null check (connection_key_type in ('vin', 'vehicle', 'reference', 'unmatched')),
  vin text not null default '',
  vehicle_no_display text not null default '',
  vehicle_no_norm text not null default '',
  customer_name text not null default '',
  invoice_reference text,
  job_card_reference text,
  field_confidence jsonb not null default '{}'::jsonb,
  status text not null default 'needs_review' check (status in ('needs_review', 'ready', 'paid')),
  uploaded_by uuid not null references public.profiles(id),
  paid_at timestamptz,
  paid_by uuid references public.profiles(id),
  payment_batch_id uuid,
  delete_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'paid' and paid_at is not null and paid_by is not null and delete_after is not null)
    or
    (status <> 'paid' and paid_at is null and paid_by is null and delete_after is null)
  )
);

create table public.bill_edit_log (
  id bigint generated always as identity primary key,
  bill_id uuid not null references public.bills(id) on delete cascade,
  changed_by uuid not null references public.profiles(id),
  old_values jsonb not null,
  new_values jsonb not null,
  changed_at timestamptz not null default now()
);

create table public.purge_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  bills_deleted integer not null default 0,
  uploads_deleted integer not null default 0,
  shared_files_retained integer not null default 0,
  error_count integer not null default 0
);

create index bills_customer_name_trgm on public.bills using gin (customer_name gin_trgm_ops);
create index bills_vehicle_no_norm on public.bills (vehicle_no_norm);
create index bills_vin on public.bills (vin);
create index bills_vin_suffix on public.bills ((right(vin, 6)));
create index bills_connection_key on public.bills (connection_key);
create index bills_status_delete_after on public.bills (status, delete_after);
create index uploads_file_hash on public.uploads (file_hash) where file_hash is not null;

create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger uploads_touch_updated_at before update on public.uploads
for each row execute function public.touch_updated_at();
create trigger bills_touch_updated_at before update on public.bills
for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.uploads enable row level security;
alter table public.bills enable row level security;
alter table public.bill_edit_log enable row level security;
alter table public.purge_runs enable row level security;

create policy "profiles read self" on public.profiles for select using (id = auth.uid());

create policy "advisors create uploads" on public.uploads for insert
with check (uploaded_by = auth.uid() and public.current_role() = 'service_advisor');
create policy "advisors read own uploads" on public.uploads for select
using (uploaded_by = auth.uid());
create policy "cashiers read confirmed uploads" on public.uploads for select
using (public.current_role() = 'cashier' and confirmed_at is not null);

create policy "advisors read own bills" on public.bills for select
using (uploaded_by = auth.uid());
create policy "cashiers read confirmed bills" on public.bills for select
using (
  public.current_role() = 'cashier'
  and exists (
    select 1 from public.uploads u
    where u.id = upload_id and u.confirmed_at is not null
  )
);
create policy "advisors edit own unpaid bills" on public.bills for update
using (uploaded_by = auth.uid() and status <> 'paid')
with check (uploaded_by = auth.uid() and status <> 'paid');
create policy "cashiers edit confirmed unpaid bills" on public.bills for update
using (
  public.current_role() = 'cashier' and status <> 'paid'
  and exists (select 1 from public.uploads u where u.id = upload_id and u.confirmed_at is not null)
)
with check (public.current_role() = 'cashier');

create policy "staff read relevant edits" on public.bill_edit_log for select
using (
  exists (
    select 1 from public.bills b
    where b.id = bill_id
      and (b.uploaded_by = auth.uid() or public.current_role() = 'cashier')
  )
);
create policy "staff create relevant edits" on public.bill_edit_log for insert
with check (
  changed_by = auth.uid()
  and exists (
    select 1 from public.bills b
    where b.id = bill_id and b.status <> 'paid'
      and (b.uploaded_by = auth.uid() or public.current_role() = 'cashier')
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bills', 'bills', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "advisors upload own pdfs" on storage.objects for insert to authenticated
with check (
  bucket_id = 'bills'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.current_role() = 'service_advisor'
);
create policy "advisors read own pdfs" on storage.objects for select to authenticated
using (bucket_id = 'bills' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cashiers read bill pdfs" on storage.objects for select to authenticated
using (
  bucket_id = 'bills'
  and public.current_role() = 'cashier'
  and exists (
    select 1 from public.uploads u
    where u.storage_path = name and u.confirmed_at is not null
  )
);

create or replace function public.recompute_bill_fields()
returns trigger
language plpgsql
as $$
begin
  new.vin := upper(regexp_replace(coalesce(new.vin, ''), '[^A-Za-z0-9]', '', 'g'));
  new.vehicle_no_norm := upper(regexp_replace(coalesce(new.vehicle_no_display, ''), '[^A-Za-z0-9]', '', 'g'));
  if new.vin <> '' then
    new.connection_key := 'VIN:' || new.vin;
    new.connection_key_type := 'vin';
  elsif new.vehicle_no_norm <> '' then
    new.connection_key := 'VEHICLE:' || new.vehicle_no_norm;
    new.connection_key_type := 'vehicle';
  elsif nullif(new.invoice_reference, '') is not null or nullif(new.job_card_reference, '') is not null then
    new.connection_key := 'REFERENCE:' || upper(coalesce(nullif(new.job_card_reference, ''), new.invoice_reference));
    new.connection_key_type := 'reference';
  else
    new.connection_key := 'UNMATCHED:' || new.id::text;
    new.connection_key_type := 'unmatched';
  end if;
  return new;
end;
$$;

create trigger bills_recompute_fields before insert or update of vin, vehicle_no_display, invoice_reference, job_card_reference
on public.bills for each row execute function public.recompute_bill_fields();

create or replace function public.log_bill_field_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if row(old.vin, old.vehicle_no_display, old.customer_name, old.invoice_reference, old.job_card_reference)
     is distinct from
     row(new.vin, new.vehicle_no_display, new.customer_name, new.invoice_reference, new.job_card_reference) then
    insert into public.bill_edit_log (bill_id, changed_by, old_values, new_values)
    values (
      new.id,
      coalesce(auth.uid(), new.uploaded_by),
      jsonb_build_object(
        'vin', old.vin, 'vehicle_no', old.vehicle_no_display, 'customer_name', old.customer_name,
        'invoice_reference', old.invoice_reference, 'job_card_reference', old.job_card_reference
      ),
      jsonb_build_object(
        'vin', new.vin, 'vehicle_no', new.vehicle_no_display, 'customer_name', new.customer_name,
        'invoice_reference', new.invoice_reference, 'job_card_reference', new.job_card_reference
      )
    );
  end if;
  return new;
end;
$$;

create trigger bills_log_field_edit after update of vin, vehicle_no_display, customer_name, invoice_reference, job_card_reference
on public.bills for each row execute function public.log_bill_field_edit();

create or replace function public.search_bills(
  search_text text default '',
  status_filter text default 'all',
  bill_date date default (now() at time zone 'Asia/Kolkata')::date
)
returns setof public.bills
language sql
stable
set search_path = public
as $$
  with input as (
    select
      trim(search_text) as raw,
      upper(regexp_replace(search_text, '[^A-Za-z0-9]', '', 'g')) as normalized
  )
  select b.*
  from public.bills b
  join public.uploads u on u.id = b.upload_id and u.confirmed_at is not null
  cross join input i
  where (b.created_at at time zone 'Asia/Kolkata')::date = bill_date
    and case status_filter
      when 'paid' then b.status = 'paid'
      when 'unpaid' then b.status <> 'paid'
      when 'needs_review' then b.status = 'needs_review'
      else true
    end
    and (
      i.raw = ''
      or b.vin = i.normalized
      or (length(i.normalized) = 6 and right(b.vin, 6) = i.normalized)
      or b.vehicle_no_norm like '%' || i.normalized || '%'
      or b.customer_name ilike '%' || i.raw || '%'
      or similarity(b.customer_name, i.raw) >= 0.25
    )
  order by
    case
      when b.vin = i.normalized then 0
      when right(b.vin, 6) = i.normalized then 1
      when b.vehicle_no_norm = i.normalized then 2
      when b.vehicle_no_norm like '%' || i.normalized || '%' then 3
      else 4
    end,
    similarity(b.customer_name, i.raw) desc,
    b.created_at desc;
$$;

create or replace function public.mark_bills_paid(target_ids uuid[])
returns setof public.bills
language plpgsql
security definer
set search_path = public
as $$
declare
  batch uuid := gen_random_uuid();
begin
  if public.current_role() <> 'cashier' then raise exception 'cashier role required'; end if;
  return query
    update public.bills
    set status = 'paid', paid_at = now(), paid_by = auth.uid(),
        payment_batch_id = batch, delete_after = now() + interval '24 hours'
    where id = any(target_ids) and status <> 'paid'
    returning *;
end;
$$;

create or replace function public.undo_payment(target_ids uuid[] default null, target_batch uuid default null)
returns setof public.bills
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() <> 'cashier' then raise exception 'cashier role required'; end if;
  return query
    update public.bills
    set status = case when vin <> '' and vehicle_no_display <> '' and customer_name <> '' then 'ready' else 'needs_review' end,
        paid_at = null, paid_by = null, payment_batch_id = null, delete_after = null
    where status = 'paid'
      and ((target_ids is not null and id = any(target_ids)) or (target_batch is not null and payment_batch_id = target_batch))
    returning *;
end;
$$;

grant execute on function public.mark_bills_paid(uuid[]) to authenticated;
grant execute on function public.undo_payment(uuid[], uuid) to authenticated;
grant execute on function public.search_bills(text, text, date) to authenticated;

alter publication supabase_realtime add table public.bills;
