-- BETA: staff two-step verification (MFA) is switched OFF for now.
-- Staff sign in with email + password only (aal1). Everything else (roles,
-- assignments, RLS, maker-checker) is unchanged.
--
-- To turn MFA back on before production, run:
--   update private.settings set value = 'true'::jsonb where key = 'require_staff_mfa';

update private.settings set value = 'false'::jsonb where key = 'require_staff_mfa';

insert into supabase_migrations.schema_migrations (version, name)
values ('0034', 'beta_disable_staff_mfa') on conflict (version) do nothing;
