-- Phase 6 read model: per-client intake counts for dashboards.
-- SECURITY INVOKER: RLS decides what the caller may count.
create function public.intake_summary(p_client_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'transactions', coalesce((
      select jsonb_object_agg(status, n) from (
        select status::text as status, count(*) as n from public.intake_transactions
         where client_id = p_client_id group by status) t), '{}'::jsonb),
    'counterparties', coalesce((
      select jsonb_object_agg(status, n) from (
        select status::text as status, count(*) as n from public.counterparties
         where client_id = p_client_id group by status) c), '{}'::jsonb),
    'documents', coalesce((
      select jsonb_object_agg(review_status, n) from (
        select review_status::text as review_status, count(*) as n from public.documents
         where client_id = p_client_id and deleted_at is null and upload_state = 'complete'
         group by review_status) d), '{}'::jsonb),
    'profile', (select jsonb_build_object('status', status, 'version', version)
                  from public.business_profiles where client_id = p_client_id
                 order by version desc limit 1),
    'imports_open', (select count(*) from public.import_batches
                      where client_id = p_client_id and status in ('uploaded', 'mapped'))
  );
$$;

revoke execute on function public.intake_summary(uuid) from public, anon;
grant execute on function public.intake_summary(uuid) to authenticated;
