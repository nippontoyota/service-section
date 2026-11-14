begin;
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('cashier','service_advisor','super_admin','security'));

create table public.gate_passes (
 id uuid primary key,
 code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
 customer_id uuid not null references public.customers(id),
 customer_name text not null,
 vehicle text not null check (vehicle ~ '^[A-Z0-9]+$'),
 issuer_id uuid references public.profiles(id) on delete set null,
 issuer_name text not null,
 recipient text not null check (recipient ~ '^\+[1-9][0-9]{7,14}$'),
 issued_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
 status text not null default 'active' check (status in ('active','revoked','used')),
 exit_at timestamptz,
 guard_id uuid references public.profiles(id) on delete set null,
 guard_name text,
 check ((status = 'used') = (exit_at is not null)),
 check (expires_at > issued_at)
);
create unique index gate_pass_active_vehicle on public.gate_passes(customer_id,vehicle) where status='active';
create table public.gate_pass_bills (
 pass_id uuid not null references public.gate_passes(id),
 bill_id uuid not null references public.bills(id) on delete restrict,
 primary key(pass_id,bill_id)
);
create index gate_pass_bills_bill on public.gate_pass_bills(bill_id);
alter table public.gate_passes enable row level security;
alter table public.gate_pass_bills enable row level security;
revoke all on public.gate_passes, public.gate_pass_bills from public, anon, authenticated;
grant all on public.gate_passes, public.gate_pass_bills to service_role;

-- ponytail: serialize ledger/submission writes globally for this single service desk.
-- Move to ordered customer/vehicle locks if write throughput becomes a constraint.
create function public.gate_lock() returns void language sql volatile as $$
 select pg_advisory_xact_lock(73492166014002)
$$;
create function public.gate_write_lock() returns trigger language plpgsql as $$ begin
 perform public.gate_lock(); return null;
end $$;
create trigger gate_lock_bills before insert or update or delete on public.bills for each statement execute function public.gate_write_lock();
create trigger gate_lock_payments before insert or update or delete on public.payments for each statement execute function public.gate_write_lock();
create trigger gate_lock_uploads before insert or update or delete on public.uploads for each statement execute function public.gate_write_lock();
-- Acquire before the existing functions take row locks, preventing lock-order inversion.
do $$ declare f regprocedure; d text; begin
 foreach f in array array['public.desk_action(text,uuid,text,text,text)'::regprocedure,
 'public.app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean)'::regprocedure] loop
 d := pg_get_functiondef(f);
 d := regexp_replace(d, '\mbegin\M', 'begin PERFORM public.gate_lock();', 'i');
 execute d;
 end loop;
end $$;
create function public.gate_revoke_payment() returns trigger language plpgsql security definer set search_path=public as $$ begin
 update gate_passes set status='revoked' where status='active' and id in
 (select pass_id from gate_pass_bills where bill_id=coalesce(new.bill_id,old.bill_id));
 return null;
end $$;
create trigger gate_payment_reversed after insert on public.payments for each row
 when (new.source='reversal') execute function public.gate_revoke_payment();
create trigger gate_payment_changed after update of bill_id,amount_paise,is_archived,source,reversal_of on public.payments
for each row execute function public.gate_revoke_payment();
create trigger gate_payment_deleted after delete on public.payments for each row execute function public.gate_revoke_payment();

create function public.gate_vehicle(value text) returns text language sql immutable as $$
 select upper(regexp_replace(coalesce(value,''),'[^A-Za-z0-9]','','g'))
$$;
create function public.gate_bills(customer uuid, registration text)
returns table(id uuid, reference text, cleared boolean, completed boolean) language sql stable set search_path=public as $$
 select b.id, coalesce(nullif(b.invoice_reference,''),b.id::text),
 case when b.amount_paise is null and b.field_confidence->'document'->>'kind' in ('warranty_note','amc_note')
   and b.amount_evidence like 'No monetary total stated;%' then true
 else b.amount_paise is not null and b.approval_status='approved'
   and b.amount_paise=(select coalesce(sum(p.amount_paise),0) from payments p where p.bill_id=b.id and not p.is_archived) end,
 exists(select 1 from gate_pass_bills gb join gate_passes gp on gp.id=gb.pass_id where gb.bill_id=b.id and gp.status='used')
 from bills b join uploads u on u.id=b.upload_id
 where b.customer_id=customer and gate_vehicle(b.vehicle_no_display)=registration and u.confirmed_at is not null
$$;
create function public.gate_result(pass public.gate_passes) returns jsonb language plpgsql volatile set search_path=public as $$
declare result text; begin
 if pass.id is null then return jsonb_build_object('status','Invalid'); end if;
 result := case when pass.status='used' then 'Already used' when pass.status='revoked' then 'Revoked'
 when pass.expires_at<=clock_timestamp() then 'Expired' else 'Valid' end;
 if result='Valid' and (
 exists(select 1 from gate_bills(pass.customer_id,pass.vehicle) b where not b.cleared)
 or exists(select 1 from gate_bills(pass.customer_id,pass.vehicle) b where not b.completed and not exists
 (select 1 from gate_pass_bills gb where gb.pass_id=pass.id and gb.bill_id=b.id))
 or not exists(select 1 from gate_pass_bills where pass_id=pass.id)
 ) then result:='Payment not cleared'; end if;
 return jsonb_build_object('status',result,'id',pass.id,'customerName',pass.customer_name,
 'vehicle',pass.vehicle,'issuer',pass.issuer_name,'expiresAt',pass.expires_at,'exitAt',pass.exit_at);
end $$;
create function public.app_issue_gate_pass(staff uuid, target uuid, phone text, pass_id uuid, pass_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b bills; p gate_passes; registration text; ids uuid[]; blocked jsonb; begin
 perform gate_lock(); perform app_set_actor(staff);
 if public.current_role()<>'cashier' then raise exception 'Cashier role required' using errcode='42501'; end if;
 if phone is null or phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Valid customer WhatsApp number required'; end if;
 select * into b from bills where id=target;
 registration:=gate_vehicle(b.vehicle_no_display);
 if b.id is null or registration='' or nullif(trim(b.customer_name),'') is null
 or not exists(select 1 from customers where id=b.customer_id and identity_key not like 'UNMATCHED:%')
 or not exists(select 1 from uploads where id=b.upload_id and confirmed_at is not null)
 then raise exception 'Identified customer, vehicle registration and submitted bill required'; end if;
 if exists(select 1 from gate_pass_bills gb join gate_passes gp on gp.id=gb.pass_id where gb.bill_id=target and gp.status='used')
 then return jsonb_build_object('error','This bill already covered a completed exit. Select newly submitted bills for a later visit.'); end if;
 select jsonb_agg(jsonb_build_object('id',g.id,'reference',g.reference)) into blocked from gate_bills(b.customer_id,registration) g where not g.cleared;
 if blocked is not null then return jsonb_build_object('error','Payment not cleared. Settle or correct these bills first.','blockers',blocked); end if;
 select array_agg(g.id order by g.id) into ids from gate_bills(b.customer_id,registration) g where not g.completed;
 if coalesce(cardinality(ids),0)=0 then return jsonb_build_object('error','New submitted bills are required for another exit.'); end if;
 select * into p from gate_passes where customer_id=b.customer_id and vehicle=registration and status='active';
 if p.id is not null and p.expires_at>clock_timestamp()
 and ids=(select array_agg(bill_id order by bill_id) from gate_pass_bills where gate_pass_bills.pass_id=p.id) then
 update gate_passes set recipient=phone where id=p.id;
 else
 update gate_passes set status='revoked' where customer_id=b.customer_id and vehicle=registration and status='active';
 insert into gate_passes(id,code_hash,customer_id,customer_name,vehicle,issuer_id,issuer_name,recipient)
 select pass_id,pass_hash,b.customer_id,b.customer_name,registration,staff,full_name,phone from profiles where id=staff returning * into p;
 insert into gate_pass_bills(pass_id,bill_id) select p.id,unnest(ids);
 end if;
 insert into audit_events(actor_id,bill_id,action,detail) values(staff,target,'gate_pass_prepared',jsonb_build_object('pass_id',p.id));
 return gate_result(p);
end $$;
create function public.app_public_gate_pass(pass_hash text) returns jsonb
language plpgsql security definer set search_path=public as $$ declare p gate_passes; begin
 perform gate_lock(); select * into p from gate_passes where code_hash=pass_hash;
 return gate_result(p) - 'issuer';
end $$;
create function public.app_check_gate_pass(staff uuid, pass_hash text, confirm_exit boolean default false) returns jsonb
language plpgsql security definer set search_path=public as $$ declare p gate_passes; result jsonb; begin
 perform gate_lock(); perform app_set_actor(staff);
 if public.current_role()<>'security' then raise exception 'Security role required' using errcode='42501'; end if;
 select * into p from gate_passes where code_hash=pass_hash for update;
 result:=gate_result(p);
 if confirm_exit and result->>'status'='Valid' then
 update gate_passes set status='used',exit_at=clock_timestamp(),guard_id=staff,
 guard_name=(select full_name from profiles where id=staff) where id=p.id returning * into p;
 insert into audit_events(actor_id,action,detail) values(staff,'gate_exit_confirmed',jsonb_build_object('pass_id',p.id,'vehicle',p.vehicle));
 result:=gate_result(p) || jsonb_build_object('confirmed',true);
 end if;
 return result;
end $$;
create or replace function public.app_desk_snapshot(staff uuid) returns jsonb
language plpgsql security definer set search_path=public as $$ begin
 perform app_set_actor(staff);
 if public.current_role()='security' then raise exception 'Financial workspace not accessible' using errcode='42501'; end if;
 return desk_snapshot();
end $$;
-- All gate functions are internal; only the server holds the service credential.
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
 and (proname like 'gate_%' or proname like 'app_%gate_pass') loop
 execute format('revoke all on function %s from public, anon, authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
commit;
