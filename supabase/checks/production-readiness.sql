-- Production readiness check (READ-ONLY). Run in the Supabase SQL Editor of the
-- PRODUCTION project after migrations, before go-live, and after every release.
-- Every row should be PASS. REVIEW rows need an owner decision; FAIL blocks go-live.
-- This file is NOT a migration: it changes nothing.

with
settings as (
  select key, value::text as v from private.settings
),
tables as (
  select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
),
checks as (
  select 10 as ord, 'Migrations applied up to 0044' as check_name,
         case when (select max(version) from supabase_migrations.schema_migrations) >= '0044' then 'PASS' else 'FAIL' end as status,
         'latest = ' || coalesce((select max(version) from supabase_migrations.schema_migrations), 'none') as detail
  union all
  select 20, 'Staff MFA required',
         case when (select v from settings where key = 'require_staff_mfa') = 'true' then 'PASS' else 'FAIL' end,
         'require_staff_mfa = ' || coalesce((select v from settings where key = 'require_staff_mfa'), 'missing')
  union all
  select 30, 'Synthetic-data purge disabled',
         case when coalesce((select v from settings where key = 'allow_synthetic_purge'), 'false') = 'false' then 'PASS' else 'FAIL' end,
         'allow_synthetic_purge = ' || coalesce((select v from settings where key = 'allow_synthetic_purge'), 'missing')
  union all
  select 40, 'RLS enabled and forced on every public table',
         case when not exists (select 1 from tables where not (relrowsecurity and relforcerowsecurity)) then 'PASS' else 'FAIL' end,
         coalesce((select string_agg(relname, ', ') from tables where not (relrowsecurity and relforcerowsecurity)), 'all tables')
  union all
  select 50, 'Every public table has a policy',
         case when not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                where n.nspname = 'public' and c.relkind = 'r'
                                  and not exists (select 1 from pg_policy p where p.polrelid = c.oid)) then 'PASS' else 'FAIL' end,
         ''
  union all
  select 60, 'No anon access to tables',
         case when not exists (select 1 from information_schema.role_table_grants
                                where grantee = 'anon' and table_schema in ('public', 'private', 'audit')) then 'PASS' else 'FAIL' end,
         ''
  union all
  select 70, 'No anon access to functions',
         case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                where n.nspname in ('public', 'private', 'audit')
                                  and has_function_privilege('anon', p.oid, 'execute')) then 'PASS' else 'FAIL' end,
         ''
  union all
  select 80, 'Direct writes only on allow-listed tables',
         case when not exists (select 1 from information_schema.role_table_grants
                                where grantee = 'authenticated' and table_schema = 'public'
                                  and privilege_type <> 'SELECT' and table_name <> 'client_contacts') then 'PASS' else 'FAIL' end,
         ''
  union all
  select 90, 'Security-definer functions pin search_path',
         case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                where n.nspname in ('public', 'private', 'audit') and p.prosecdef
                                  and not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=""'])) then 'PASS' else 'FAIL' end,
         ''
  union all
  select 100, 'Storage buckets are private',
         case when not exists (select 1 from storage.buckets where public) then 'PASS' else 'FAIL' end,
         coalesce((select string_agg(id, ', ') from storage.buckets where public), '')
  union all
  select 110, 'No synthetic or demo clients',
         case when not exists (select 1 from public.clients
                                where code ~* '^(ZZTEST|DEMO|TEST)' or display_name ~* '(synthetic|demo|test only)') then 'PASS' else 'FAIL' end,
         coalesce((select string_agg(code, ', ') from public.clients
                    where code ~* '^(ZZTEST|DEMO|TEST)' or display_name ~* '(synthetic|demo|test only)'), '')
  union all
  select 120, 'No test or demo user accounts',
         case when not exists (select 1 from public.profiles
                                where email ~* '@example\.(com|test|org)$' or email ~* '^demo\.') then 'PASS' else 'FAIL' end,
         (select count(*)::text from public.profiles where email ~* '@example\.(com|test|org)$' or email ~* '^demo\.') || ' found'
  union all
  select 130, 'Firm admins (expect 1-2 named people)',
         case when (select count(*) from public.firm_memberships where role = 'firm_admin') between 1 and 2 then 'PASS' else 'REVIEW' end,
         (select count(*)::text from public.firm_memberships where role = 'firm_admin') || ' firm admin(s)'
  union all
  select 140, 'No TEST-ONLY tax definitions',
         case when not exists (select 1 from public.tax_rules where code ~ '^TEST' or sources::text ~* 'test only')
               and not exists (select 1 from public.tax_forms where form_code ~ '^TEST' or official_version ~* 'test')
               and not exists (select 1 from public.output_specs where output_code ~ '^TEST' or spec_source::text ~* 'test only')
              then 'PASS' else 'FAIL' end,
         ''
  union all
  select 150, 'Approved tax rules (each needs its gate evidence)',
         case when (select count(*) from public.tax_rules where status = 'approved') = 0 then 'PASS' else 'REVIEW' end,
         coalesce((select string_agg(code || ' v' || version, ', ') from public.tax_rules where status = 'approved'), 'none')
  union all
  select 160, 'Enabled tax forms (each needs its sign-off)',
         case when (select count(*) from public.tax_forms where status = 'enabled') = 0 then 'PASS' else 'REVIEW' end,
         coalesce((select string_agg(form_code || ' v' || version, ', ') from public.tax_forms where status = 'enabled'), 'none')
  union all
  select 170, 'Enabled electronic outputs (each needs its sign-off)',
         case when (select count(*) from public.output_specs where status = 'enabled') = 0 then 'PASS' else 'REVIEW' end,
         coalesce((select string_agg(output_code || ' v' || version, ', ') from public.output_specs where status = 'enabled'), 'none')
  union all
  select 180, 'Deadline rules pending verification',
         case when (select count(*) from public.deadline_rules where status = 'pending_verification') = 0 then 'PASS' else 'REVIEW' end,
         coalesce((select string_agg(code, ', ') from public.deadline_rules where status = 'pending_verification'), 'none')
  union all
  select 190, 'Every posted entry balances',
         case when not exists (select 1 from public.journal_entries e join public.journal_lines l on l.entry_id = e.id
                                where e.status in ('posted', 'reversed') group by e.id
                               having sum(l.debit) <> sum(l.credit)) then 'PASS' else 'FAIL' end,
         ''
)
select status, check_name, detail from checks order by ord;
