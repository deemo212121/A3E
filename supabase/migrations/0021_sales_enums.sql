-- Phase 7 (sales and receivables), part 1 of 3: types.
-- Kept separate because new enum values cannot be used in the same
-- transaction that adds them. Run this file on its own, before 0022.

alter type public.intake_subject add value if not exists 'sales_invoice';
alter type public.intake_subject add value if not exists 'credit_note';
alter type public.intake_subject add value if not exists 'sales_receipt';

-- Sales documents: prepared (draft) -> submitted -> posted by a different
-- person (approval = posting) -> cancelled only through a controlled workflow.
create type public.sales_doc_status as enum ('draft', 'submitted', 'posted', 'cancelled');

-- Tax classification of a sales line, as the CLIENT's invoice states it.
-- 'not_subject' = sale by a non-VAT-registered seller (no VAT shown).
create type public.sales_tax_class as enum ('vatable', 'zero_rated', 'exempt', 'not_subject');

insert into supabase_migrations.schema_migrations (version, name)
values ('0021', 'sales_enums') on conflict (version) do nothing;
