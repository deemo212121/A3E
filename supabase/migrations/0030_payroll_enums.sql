-- Phase 10 (payroll and statutory contributions), part 1 of 3: types.
-- Run on its own, before 0031.

create type public.payroll_access_level as enum ('view', 'prepare', 'approve');
create type public.payroll_frequency as enum ('monthly', 'semi_monthly');
create type public.payroll_rule_kind as enum ('sss', 'philhealth', 'pagibig', 'withholding');
-- fixed_table: fixed employee/employer/EC amounts per compensation bracket;
-- rate_table: rates per bracket applied to the base between a floor and a ceiling;
-- graduated: fixed tax + rate on the excess over the bracket's lower bound.
create type public.payroll_rule_method as enum ('fixed_table', 'rate_table', 'graduated');
create type public.pay_basis as enum ('monthly', 'daily');
create type public.payroll_item_kind as enum ('earning', 'deduction');
create type public.payroll_item_unit as enum ('amount', 'days', 'hours');
create type public.payroll_payment_kind as enum ('net_pay', 'sss', 'philhealth', 'pagibig', 'withholding', 'deduction');

insert into supabase_migrations.schema_migrations (version, name)
values ('0030', 'payroll_enums') on conflict (version) do nothing;
