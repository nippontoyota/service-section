begin;
-- Null expiry records attachment preparation; existing expiring-link calls remain valid.
create or replace function public.app_prepare_whatsapp(staff uuid, target uuid, phone text, expires_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare b public.bills;
begin
  perform public.app_set_actor(staff);
  if public.current_role() <> 'service_advisor' then
    raise exception 'Service advisor role required' using errcode = '42501';
  end if;
  select * into b from public.bills where id = target and uploaded_by = staff for update;
  if not found then raise exception 'Bill not accessible' using errcode = 'P0002'; end if;
  if not exists(select 1 from public.uploads where id = b.upload_id and confirmed_at is not null) then
    raise exception 'Submit this bill to the cashier before sharing' using errcode = '55000';
  end if;
  if phone is null or phone !~ '^\+[1-9][0-9]{7,14}$' or (expires_at is not null and expires_at <= now()) then
    raise exception 'Valid customer phone and expiry required' using errcode = '22023';
  end if;
  update public.bills set customer_phone = phone where id = target;
  insert into public.audit_events(bill_id,actor_id,action,detail)
    values(target,staff,'whatsapp_prepared',jsonb_build_object('phone_last_four',right(phone,4),'mode',case when expires_at is null then 'attachment' else 'link' end) || case when expires_at is null then '{}'::jsonb else jsonb_build_object('expires_at',expires_at) end);
end $$;
revoke all on function public.app_prepare_whatsapp(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.app_prepare_whatsapp(uuid,uuid,text,timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
