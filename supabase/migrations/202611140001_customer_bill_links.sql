begin;

create table public.customer_bill_links (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  bill_id uuid not null references public.bills(id) on delete cascade,
  storage_path text not null check (
    storage_path ~ '^customer-copies/v1/[0-9a-f-]{36}/(original|[0-9a-f]{64})/[0-9a-f-]{36}-[0-9]+-[0-9]+[.]pdf$'
  ),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  check (expires_at > created_at)
);
create index customer_bill_links_bill_id_idx on public.customer_bill_links(bill_id);

alter table public.customer_bill_links enable row level security;
revoke all on public.customer_bill_links from public, anon, authenticated;
grant select, insert, update, delete on public.customer_bill_links to service_role;

commit;
