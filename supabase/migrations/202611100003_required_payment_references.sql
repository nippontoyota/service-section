-- Require references for new collections without changing historical payments.
begin;
create or replace function public.app_desk_action(staff uuid, action text, target uuid,
 reason text default '', payment_method text default '', transaction_id text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
 perform app_set_actor(staff);
 if action = 'collect' then
  if payment_method in ('GPay','Demand Draft','Cheque') then
   if nullif(trim(transaction_id),'') is null then
    if payment_method = 'Cheque' then raise exception 'Cheque number is required';
    else raise exception 'Transaction ID is required'; end if;
   end if;
  else
   transaction_id := null;
  end if;
 end if;
 perform desk_action(action,target,reason,payment_method,transaction_id);
end $$;
revoke all on function public.app_desk_action(uuid,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.app_desk_action(uuid,text,uuid,text,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
