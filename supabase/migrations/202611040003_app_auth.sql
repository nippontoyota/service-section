-- App-managed staff authentication. Run after the first three migrations.
-- Existing profile IDs, uploaded bills and audit history are preserved.
begin;
alter table public.profiles drop constraint profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();

create table public.staff_credentials (
 staff_id uuid primary key references public.profiles(id) on delete cascade,
 password_hash text not null check (password_hash ~ '^scrypt[$]32768[$]8[$]3[$][a-f0-9]{32}[$][a-f0-9]{128}$'),
 updated_at timestamptz not null default now()
);
create table public.staff_sessions (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 staff_id uuid not null references public.profiles(id) on delete cascade,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now() + interval '12 hours'
);
create index staff_sessions_staff on public.staff_sessions(staff_id);
create index staff_sessions_expiry on public.staff_sessions(expires_at);
create table public.staff_login_attempts (
 login_id text primary key,
 window_start timestamptz not null default now(),
 attempts integer not null default 1
);
alter table public.staff_credentials enable row level security;
alter table public.staff_sessions enable row level security;
alter table public.staff_login_attempts enable row level security;

-- All application data now goes through the checked server API. Old Auth JWTs
-- and publishable keys must no longer grant direct table or PDF access.
do $$ declare p record; begin
 for p in select tablename, policyname from pg_policies where schemaname = 'public'
 and tablename in ('profiles','uploads','bills','bill_edit_log','purge_runs','payments','audit_events','customers')
 loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
drop policy if exists "advisors upload own pdfs" on storage.objects;
drop policy if exists staff_read_pdfs on storage.objects;
revoke all on public.profiles, public.uploads, public.bills, public.bill_edit_log,
 public.purge_runs, public.payments, public.audit_events, public.customers,
 public.staff_credentials, public.staff_sessions, public.staff_login_attempts from public, anon, authenticated;
grant all on public.profiles, public.uploads, public.bills, public.bill_edit_log,
 public.purge_runs, public.payments, public.audit_events, public.customers,
 public.staff_credentials, public.staff_sessions, public.staff_login_attempts to service_role;

create function public.app_actor_id() returns uuid language sql stable as $$
 select nullif(current_setting('billdesk.staff_id', true),'')::uuid
$$;
-- Reuse the tested ledger/snapshot logic, but remove its Supabase Auth identity dependency.
do $$ declare f regprocedure; begin
 foreach f in array array['public.current_role()'::regprocedure,
 'public.desk_snapshot()'::regprocedure,'public.desk_action(text,uuid,text)'::regprocedure,
 'public.log_bill_field_edit()'::regprocedure] loop
  execute replace(pg_get_functiondef(f), 'auth.uid()', 'public.app_actor_id()');
 end loop;
end $$;
revoke all on function public.current_role(), public.desk_snapshot(), public.desk_action(text,uuid,text),
 public.search_bills(text,text,date), public.mark_bills_paid(uuid[]), public.undo_payment(uuid[],uuid)
 from public, anon, authenticated;

create function public.app_set_actor(staff uuid) returns void
language plpgsql security definer set search_path = public as $$ begin
 if not exists(select 1 from profiles where id=staff and active and not must_change_password)
 then raise exception 'Active staff login required'; end if;
 perform set_config('billdesk.staff_id',staff::text,true);
end $$;
create function public.app_desk_snapshot(staff uuid) returns jsonb
language plpgsql security definer set search_path = public as $$ begin
 perform app_set_actor(staff);
 return desk_snapshot();
end $$;
create function public.app_desk_action(staff uuid, action text, target uuid, reason text default '') returns void
language plpgsql security definer set search_path = public as $$ begin
 perform app_set_actor(staff);
 perform desk_action(action,target,reason);
end $$;

create function public.app_revoke_sessions() returns trigger
language plpgsql security definer set search_path = public as $$ begin
 delete from staff_sessions where staff_id=new.id;
 return new;
end $$;
create trigger profile_access_changed after update of active, role, must_change_password on public.profiles
for each row when (old.active is distinct from new.active or old.role is distinct from new.role
 or old.must_change_password is distinct from new.must_change_password) execute function public.app_revoke_sessions();
create function public.app_password_changed() returns trigger
language plpgsql security definer set search_path = public as $$ begin
 delete from staff_sessions where staff_id=new.staff_id;
 new.updated_at=now();
 return new;
end $$;
create trigger credential_changed before update of password_hash on public.staff_credentials
for each row execute function public.app_password_changed();

create function public.app_open_session(staff uuid, expected_hash text, session_hash text) returns void
language plpgsql security definer set search_path = public as $$ begin
 perform 1 from profiles where id=staff and active for share;
 if not found then raise exception 'Active staff login required'; end if;
 perform 1 from staff_credentials where staff_id=staff and password_hash=expected_hash for share;
 if not found then raise exception 'Credentials changed; sign in again'; end if;
 delete from staff_sessions where expires_at <= now();
 insert into staff_sessions(token_hash,staff_id) values(session_hash,staff);
end $$;

create function public.app_login_attempt(login_id text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer; begin
 if login_id !~ '^[a-z0-9_]{3,40}$' then return false; end if;
 delete from staff_login_attempts where window_start < now() - interval '15 minutes';
 insert into staff_login_attempts as a(login_id) values(login_id)
 on conflict on constraint staff_login_attempts_pkey do update set attempts=a.attempts+1 returning attempts into n;
 return n <= 10;
end $$;

create function public.app_bootstrap_staff(login_id text, name text, role_name text, new_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare p profiles; begin
 insert into profiles(staff_id,full_name,role,must_change_password) values(login_id,name,role_name,false)
 on conflict (staff_id) do nothing;
 select * into p from profiles where staff_id=login_id for update;
 if p.role <> role_name then raise exception 'Existing staff role does not match bootstrap role'; end if;
 if exists(select 1 from staff_credentials where staff_id=p.id) then return false; end if;
 insert into staff_credentials(staff_id,password_hash) values(p.id,new_hash);
 update profiles set must_change_password=false where id=p.id;
 insert into audit_events(actor_id,action,detail) values(p.id,'credentials_initialized',jsonb_build_object('target',p.id));
 return true;
end $$;

create function public.app_staff_account(actor uuid, operation text, target uuid default null,
 new_hash text default null, login_id text default null, name text default null,
 role_name text default null, enabled boolean default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare a profiles; result uuid := target; begin
 select * into a from profiles where id=actor and active for update;
 if not found then raise exception 'Active staff login required'; end if;
 if operation = 'password' then
  result := actor;
 else
  if a.role <> 'super_admin' or a.must_change_password then raise exception 'Super admin role required'; end if;
  if target = actor then raise exception 'You cannot disable or reset your own account here'; end if;
 end if;
 if operation = 'create_staff' then
  if nullif(trim(name),'') is null or length(name)>100 then raise exception 'Valid staff name required'; end if;
  insert into profiles(staff_id,full_name,role,must_change_password)
  values(login_id,trim(name),role_name,true) returning id into result;
 elsif operation not in ('password','reset_staff','toggle_staff') then
  raise exception 'Unknown staff operation';
 else
  perform 1 from profiles where id=result for update;
  if not found then raise exception 'Staff account not found'; end if;
 end if;
 if operation = 'toggle_staff' then
  if enabled is null then raise exception 'Account status required'; end if;
  update profiles set active=enabled where id=result;
 else
  insert into staff_credentials(staff_id,password_hash) values(result,new_hash)
  on conflict(staff_id) do update set password_hash=excluded.password_hash;
  update profiles set must_change_password=(operation <> 'password') where id=result;
 end if;
 insert into audit_events(actor_id,action,detail)
 values(actor,operation,jsonb_build_object('target',result,'active',enabled));
 return result;
end $$;

-- These functions accept trusted server identities, never client-supplied actors.
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc
 where pronamespace='public'::regnamespace and proname like 'app\_%' escape '\'
 loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
commit;
