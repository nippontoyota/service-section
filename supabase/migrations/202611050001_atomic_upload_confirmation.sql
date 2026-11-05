-- Apply before deploying the updated confirmation endpoint.
-- Existing duplicates cause this transaction to fail without changing records.
begin;

create unique index uploads_confirmed_hash_unique on public.uploads(file_hash)
where confirmed_at is not null and file_hash is not null;

create function public.app_confirm_upload(staff uuid, target uuid) returns public.uploads
language plpgsql security definer set search_path = public as $$
declare u public.uploads;
begin
  perform public.app_set_actor(staff);
  if public.current_role() <> 'service_advisor' then
    raise exception 'Service advisor role required' using errcode = '42501';
  end if;

  select * into u from public.uploads where id = target and uploaded_by = staff for update;
  if not found then
    raise exception 'Upload not found' using errcode = 'P0002';
  end if;
  -- A retried request returns its existing result, without another audit entry.
  if u.status = 'confirmed' and u.confirmed_at is not null then return u; end if;
  if u.status <> 'review' or u.confirmed_at is not null
     or u.file_hash is null or u.file_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Upload must finish processing before submission' using errcode = '55000';
  end if;
  if not exists(select 1 from public.bills where upload_id = target) then
    raise exception 'Upload has no extracted bills to submit' using errcode = '55000';
  end if;

  -- The unique index arbitrates simultaneous submissions of the same PDF.
  -- Other file hashes do not share a lock or wait on a global upload queue.
  update public.uploads set status = 'confirmed', confirmed_at = now()
  where id = target returning * into u;

  insert into public.audit_events(bill_id, actor_id, action, detail)
  select id, staff, 'submitted', '{}'::jsonb from public.bills where upload_id = target;
  return u;
end;
$$;

revoke all on function public.app_confirm_upload(uuid,uuid) from public, anon, authenticated;
grant execute on function public.app_confirm_upload(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
