-- Phase 8 (purchases, expenses, payables), part 1 of 3: types.
-- Run on its own, before 180100 (new enum values must be committed first).

alter type public.intake_subject add value if not exists 'purchase_bill';
alter type public.intake_subject add value if not exists 'supplier_payment';
alter type public.intake_subject add value if not exists 'withholding_code';
alter type public.intake_subject add value if not exists 'purchase_category';

-- Payees of reimbursements.
alter type public.counterparty_kind add value if not exists 'employee';

-- What a purchase line is, for the accounting treatment (accountant policy).
create type public.purchase_kind as enum ('inventory', 'fixed_asset', 'prepayment', 'expense');

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010180000', 'purchases_enums') on conflict (version) do nothing;
