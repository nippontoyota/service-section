begin;

alter table public.bills add column customer_phone text
  check (customer_phone is null or customer_phone ~ '^\+[1-9][0-9]{7,14}$');

-- Remove the old overload so callers cannot bypass the explicit sharing choice.
drop function public.app_confirm_upload(uuid,uuid,jsonb);
create function public.app_confirm_upload(staff uuid, target uuid, tokens jsonb, contacts jsonb, require_token boolean default false)
returns public.uploads language plpgsql security definer set search_path = public as $$
declare u public.uploads; entry record; b public.bills; choice jsonb;
begin
  perform public.app_set_actor(staff);
  if public.current_role() <> 'service_advisor' then
    raise exception 'Service advisor role required' using errcode = '42501';
  end if;
  select * into u from public.uploads where id = target and uploaded_by = staff for update;
  if not found then raise exception 'Upload not found' using errcode = 'P0002'; end if;
  if u.status = 'confirmed' and u.confirmed_at is not null then return u; end if;
  if u.status <> 'review' or u.confirmed_at is not null or u.file_hash is null or u.file_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Upload must finish processing before submission' using errcode = '55000';
  end if;
  if not exists(select 1 from public.bills where upload_id = target) then
    raise exception 'Upload has no extracted bills to submit' using errcode = '55000';
  end if;
  if tokens is null or jsonb_typeof(tokens) <> 'object' then
    raise exception 'Invalid token numbers' using errcode = '22023';
  end if;
  if contacts is null or jsonb_typeof(contacts) <> 'object' then
    raise exception 'Review the WhatsApp choice for every bill' using errcode = '22023';
  end if;
  for entry in select * from jsonb_each(tokens) loop
    if jsonb_typeof(entry.value) not in ('string','null') or length(trim(entry.value #>> '{}')) > 30
       or not exists(select 1 from public.bills where upload_id = target and id::text = entry.key) then
      raise exception 'Invalid token number or bill' using errcode = '22023';
    end if;
  end loop;
  for entry in select * from jsonb_each(contacts) loop
    if not exists(select 1 from public.bills where upload_id = target and id::text = entry.key) then
      raise exception 'Invalid contact bill' using errcode = '22023';
    end if;
  end loop;
  for b in select * from public.bills where upload_id = target for update loop
    choice := contacts -> b.id::text;
    if choice is null or jsonb_typeof(choice) <> 'object'
       or jsonb_typeof(choice -> 'skipWhatsApp') is distinct from 'boolean' then
      raise exception 'Choose WhatsApp or explicitly skip it for every bill' using errcode = '22023';
    end if;
    if not (choice ->> 'skipWhatsApp')::boolean and (
      jsonb_typeof(choice -> 'phone') is distinct from 'string'
      or (choice ->> 'phone') !~ '^\+[1-9][0-9]{7,14}$'
    ) then raise exception 'Valid customer WhatsApp number required' using errcode = '22023'; end if;
    if require_token is true and nullif(trim(case when tokens ? b.id::text then tokens ->> b.id::text else b.token_number end),'') is null then
      raise exception 'Token number is required for every bill at this branch' using errcode = '22023';
    end if;
    update public.bills set
      token_number = case when tokens ? b.id::text then nullif(trim(tokens ->> b.id::text),'') else token_number end,
      customer_phone = case when (choice ->> 'skipWhatsApp')::boolean then null else choice ->> 'phone' end
    where id = b.id;
  end loop;

  update public.uploads set status = 'confirmed', confirmed_at = now() where id = target returning * into u;
  insert into public.audit_events(bill_id,actor_id,action,detail)
    select id,staff,'submitted',jsonb_build_object('token_number',token_number) from public.bills where upload_id = target;
  insert into public.audit_events(bill_id,actor_id,action,detail)
    select id,staff,'whatsapp_skipped','{}'::jsonb from public.bills
    where upload_id = target and (contacts -> id::text ->> 'skipWhatsApp')::boolean;
  return u;
end $$;
revoke all on function public.app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.app_confirm_upload(uuid,uuid,jsonb,jsonb,boolean) to service_role;

-- Called only after a private customer PDF has been signed successfully.
create function public.app_prepare_whatsapp(staff uuid, target uuid, phone text, expires_at timestamptz)
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
  if phone is null or phone !~ '^\+[1-9][0-9]{7,14}$' or expires_at is null or expires_at <= now() then
    raise exception 'Valid customer phone and expiry required' using errcode = '22023';
  end if;
  update public.bills set customer_phone = phone where id = target;
  insert into public.audit_events(bill_id,actor_id,action,detail)
    values(target,staff,'whatsapp_prepared',jsonb_build_object('phone_last_four',right(phone,4),'expires_at',expires_at));
end $$;
revoke all on function public.app_prepare_whatsapp(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.app_prepare_whatsapp(uuid,uuid,text,timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
