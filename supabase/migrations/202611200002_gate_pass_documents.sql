begin;
alter table public.gate_passes add column number bigint generated always as identity unique;
alter table public.gate_passes add column documents jsonb not null default '[]';
grant usage,select on sequence public.gate_passes_number_seq to service_role;
update gate_passes p set documents=coalesce((select jsonb_agg(jsonb_build_object('billId',b.id,'invoiceNumber',b.invoice_reference,'invoiceDate',b.invoice_date,'jobNumber',b.job_card_reference,'jobDate',null) order by b.invoice_date,b.id)
 from gate_pass_bills gb join bills b on b.id=gb.bill_id where gb.pass_id=p.id),'[]');
alter function public.gate_result(public.gate_passes) rename to gate_result_before_documents;
create function public.gate_result(pass public.gate_passes) returns jsonb language plpgsql volatile set search_path=public as $$
declare result jsonb; begin
 result:=gate_result_before_documents(pass);
 if pass.id is null then return result; end if;
 return result || jsonb_build_object('number',pass.number,'issuedAt',pass.issued_at,'issuedBy',pass.issuer_name,'documents',pass.documents);
end $$;
alter function public.app_issue_gate_pass(uuid,uuid,text,uuid,text) rename to app_issue_gate_pass_before_documents;
create function public.app_issue_gate_pass(staff uuid,target uuid,phone text,pass_id uuid,pass_hash text,document_details jsonb default '[]')
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; p gate_passes; candidate jsonb; entry jsonb; begin
 perform gate_lock();
 if jsonb_typeof(document_details) is distinct from 'array' or jsonb_array_length(document_details)>100 then raise exception 'Invalid job details'; end if;
 for entry in select value from jsonb_array_elements(document_details) loop
  if length(coalesce(entry->>'jobNumber',''))>100 or (nullif(entry->>'jobDate','') is not null and (entry->>'jobDate') !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'Invalid job reference or date'; end if;
  if nullif(entry->>'jobDate','') is not null then perform (entry->>'jobDate')::date; end if;
 end loop;
 if (select count(*) from jsonb_array_elements(document_details))<>(select count(distinct value->>'billId') from jsonb_array_elements(document_details)) then raise exception 'Duplicate job details'; end if;
 result:=app_issue_gate_pass_before_documents(staff,target,phone,pass_id,pass_hash);
 if result ? 'error' then return result; end if;
 select * into p from gate_passes where id=(result->>'id')::uuid;
 if exists(select 1 from jsonb_array_elements(document_details) d where not exists(select 1 from gate_pass_bills gb where gb.pass_id=p.id and gb.bill_id::text=d->>'billId')) then raise exception 'Job details must belong to this gate pass'; end if;
 select jsonb_agg(jsonb_build_object('billId',b.id,'invoiceNumber',b.invoice_reference,'invoiceDate',b.invoice_date,
 'jobNumber',coalesce(nullif(trim(d.value->>'jobNumber'),''),b.job_card_reference),'jobDate',nullif(d.value->>'jobDate','')) order by b.invoice_date,b.id)
 into candidate from gate_pass_bills gb join bills b on b.id=gb.bill_id
 left join lateral (select value from jsonb_array_elements(document_details) where value->>'billId'=b.id::text) d on true where gb.pass_id=p.id;
 if p.id=pass_id or p.documents='[]' then
  update gate_passes set documents=coalesce(candidate,'[]') where id=p.id returning * into p;
 elsif document_details<>'[]' and p.documents<>candidate then
  raise exception 'An active pass already has saved job details. Its document cannot be changed on reissue';
 end if;
 return gate_result(p);
end $$;
do $$ declare f regprocedure; begin
 foreach f in array array['public.gate_result(public.gate_passes)'::regprocedure,'public.gate_result_before_documents(public.gate_passes)'::regprocedure,
 'public.app_issue_gate_pass(uuid,uuid,text,uuid,text,jsonb)'::regprocedure,'public.app_issue_gate_pass_before_documents(uuid,uuid,text,uuid,text)'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
