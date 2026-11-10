-- Admin-created accounts use the password chosen in the staff form.
-- Password resets retain their existing temporary-password behavior.
begin;
create or replace function public.app_staff_account(actor uuid, operation text, target uuid default null,
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
  values(login_id,trim(name),role_name,false) returning id into result;
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
  update profiles set must_change_password=(operation = 'reset_staff') where id=result;
 end if;
 insert into audit_events(actor_id,action,detail)
 values(actor,operation,jsonb_build_object('target',result,'active',enabled));
 return result;
end $$;

revoke all on function public.app_staff_account(uuid,text,uuid,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.app_staff_account(uuid,text,uuid,text,text,text,text,boolean) to service_role;
notify pgrst, 'reload schema';
commit;
