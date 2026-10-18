-- Migration files were renamed from timestamps (e.g. 20261010120000_...) to
-- sequential numbers (0001_, 0002_, ...). This updates the history of files
-- already run on this database so it matches the new names. Safe to run more
-- than once; on a fresh database it changes nothing.

update supabase_migrations.schema_migrations m
   set version = r.new_version
  from (values
  ('20261010120000', '0001'),
  ('20261010120100', '0002'),
  ('20261010120200', '0003'),
  ('20261010130000', '0004'),
  ('20261010140000', '0005'),
  ('20261010140100', '0006'),
  ('20261010140200', '0007'),
  ('20261010140300', '0008'),
  ('20261010140400', '0009'),
  ('20261010140500', '0010'),
  ('20261010140600', '0011'),
  ('20261010140700', '0012'),
  ('20261010150000', '0013'),
  ('20261010150100', '0014'),
  ('20261010160000', '0015'),
  ('20261010160100', '0016'),
  ('20261010160200', '0017'),
  ('20261010160300', '0018'),
  ('20261010160400', '0019'),
  ('20261010160500', '0020'),
  ('20261010170000', '0021'),
  ('20261010170100', '0022'),
  ('20261010170200', '0023'),
  ('20261010180000', '0024'),
  ('20261010180100', '0025'),
  ('20261010180200', '0026'),
  ('20261010190000', '0027'),
  ('20261010190100', '0028'),
  ('20261010190200', '0029'),
  ('20261010200000', '0030'),
  ('20261010200100', '0031'),
  ('20261010200200', '0032'),
  ('20261011210000', '0033'),
  ('20261012220000', '0034')
  ) as r(old_version, new_version)
 where m.version = r.old_version
   and not exists (select 1 from supabase_migrations.schema_migrations x where x.version = r.new_version);

insert into supabase_migrations.schema_migrations (version, name)
values ('0035', 'renumber_migration_history') on conflict (version) do nothing;
