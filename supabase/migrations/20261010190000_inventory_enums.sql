-- Phase 9 (inventory and cost of goods sold), part 1 of 3: types.
-- Run on its own, before 190100.

alter type public.intake_subject add value if not exists 'inventory_movement';
alter type public.intake_subject add value if not exists 'inventory_policy';

create type public.inventory_movement_type as enum
  ('receipt', 'issue', 'customer_return', 'supplier_return', 'transfer', 'adjustment');

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010190000', 'inventory_enums') on conflict (version) do nothing;
