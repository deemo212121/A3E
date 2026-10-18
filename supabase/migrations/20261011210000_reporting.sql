-- Phase 11 (financial statements and reconciliation): statement mapping,
-- the account-balances read model all statements are built from, and the
-- period-close rule for client users. Policies: docs/reports/ACCOUNTING-POLICIES.md
-- (PROPOSED, PENDING CPA REVIEW).
--
-- Source of truth: POSTED journal entries only (status posted or reversed; a
-- reversal entry nets its original to zero). Drafts and submitted entries
-- never appear in reports.

-- ---------------------------------------------------------------------------
-- Where each account appears on the statements (overrides of the defaults)
-- ---------------------------------------------------------------------------
create table public.account_report_mappings (
  account_id      uuid primary key,
  client_id       uuid not null references public.clients (id) on delete cascade,
  section         text not null check (section in (
                    'cash', 'current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability',
                    'equity', 'revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'other_expense',
                    'income_tax')),
  -- cash flow (indirect method) for balance-sheet accounts; null for P&L accounts
  cash_flow_class text check (cash_flow_class in ('cash', 'operating', 'investing', 'financing', 'noncash')),
  updated_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at      timestamptz not null default now(),
  foreign key (client_id, account_id) references public.accounts (client_id, id) on delete cascade,
  check ((section = 'cash') = (cash_flow_class is not distinct from 'cash')),
  check ((section in ('revenue', 'other_income', 'cost_of_sales', 'operating_expense', 'other_expense', 'income_tax'))
         = (cash_flow_class is null))
);

create trigger audit_account_report_mappings after insert or update or delete on public.account_report_mappings
  for each row execute function audit.log_change();

revoke all on table public.account_report_mappings from public, anon, authenticated;
grant select on table public.account_report_mappings to authenticated;
alter table public.account_report_mappings enable row level security;
alter table public.account_report_mappings force row level security;
create policy account_report_mappings_select on public.account_report_mappings for select to authenticated
  using (private.can_read_client(client_id));

-- Default mapping from the account type and the starter-chart code ranges
-- (PROPOSED; an accountant overrides per account).
--   assets: 10xx cash; 15xx-19xx non-current (credit-normal = contra, e.g.
--     accumulated depreciation: a non-cash add-back); others current
--   liabilities: 22xx-29xx non-current; others current
--   equity: financing
--   revenue: 41xx-49xx other income; others revenue
--   expenses: 5xxx cost of sales; 7xxx other expenses; 8xxx-9xxx income tax;
--     others operating expenses
create function private.default_report_mapping(
  p_code text, p_type public.account_type, p_normal public.normal_balance, out section text, out cash_flow_class text
)
language sql immutable set search_path = '' as $$
  select s, cf from (
    select case p_type
             when 'asset' then case when p_code like '10%' then 'cash'
                                    when substr(p_code, 1, 2) between '15' and '19' then 'noncurrent_asset'
                                    else 'current_asset' end
             when 'liability' then case when substr(p_code, 1, 2) between '22' and '29' then 'noncurrent_liability'
                                        else 'current_liability' end
             when 'equity' then 'equity'
             when 'revenue' then case when substr(p_code, 1, 2) between '41' and '49' then 'other_income' else 'revenue' end
             else case when p_code like '5%' then 'cost_of_sales'
                       when p_code like '7%' then 'other_expense'
                       when substr(p_code, 1, 1) in ('8', '9') then 'income_tax'
                       else 'operating_expense' end
           end as s
  ) x,
  lateral (select case
             when x.s = 'cash' then 'cash'
             when x.s = 'current_asset' or x.s = 'current_liability' then 'operating'
             when x.s = 'noncurrent_asset' then case when p_normal = 'credit' then 'noncash' else 'investing' end
             when x.s in ('noncurrent_liability', 'equity') then 'financing'
           end as cf) y;
$$;

create function public.set_account_report_mapping(p_account_id uuid, p_section text, p_cash_flow_class text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts;
begin
  perform private.require_active_user();
  select * into a from public.accounts where id = p_account_id;
  if not found or not private.can_maintain_coa(a.client_id) then
    raise exception 'not allowed to change this client''s statement mapping' using errcode = '42501';
  end if;
  if p_section is null then
    delete from public.account_report_mappings where account_id = a.id;
    return;
  end if;
  if not (p_section = any (case a.account_type
            when 'asset' then array['cash', 'current_asset', 'noncurrent_asset']
            when 'liability' then array['current_liability', 'noncurrent_liability']
            when 'equity' then array['equity']
            when 'revenue' then array['revenue', 'other_income']
            else array['cost_of_sales', 'operating_expense', 'other_expense', 'income_tax'] end)) then
    raise exception 'a % account cannot be shown under %', a.account_type, replace(p_section, '_', ' ')
      using errcode = '22023';
  end if;
  begin
    insert into public.account_report_mappings (account_id, client_id, section, cash_flow_class)
    values (a.id, a.client_id, p_section,
            case when p_section = 'cash' then 'cash'
                 when a.account_type in ('revenue', 'expense') then null
                 else nullif(p_cash_flow_class, '') end)
    on conflict (account_id) do update
      set section = excluded.section, cash_flow_class = excluded.cash_flow_class, updated_by = auth.uid(), updated_at = now();
  exception when check_violation or not_null_violation then
    raise exception 'choose a cash-flow class (operating, investing, financing or non-cash) for this account'
      using errcode = '22023';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Period-close rule for client users
-- ---------------------------------------------------------------------------
-- The last date through which every accounting period is closed (soft-closed
-- or locked). Client users see statements only up to this date; firm staff
-- see everything (marked preliminary while periods are open).
create function private.report_closed_through(p_client_id uuid) returns date
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select min(start_date) - 1 from public.accounting_periods where client_id = p_client_id and status = 'open'),
    (select max(end_date) from public.accounting_periods where client_id = p_client_id));
$$;

create function public.report_closed_through(p_client_id uuid) returns date
language sql stable security invoker set search_path = '' as $$
  select case when private.can_read_client(p_client_id) then private.report_closed_through(p_client_id) end;
$$;

create function private.require_report_access(p_client_id uuid, p_to date) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_read_client(p_client_id) then
    raise exception 'client not found' using errcode = '42501';
  end if;
  if not private.is_assigned(p_client_id)
     and p_to > coalesce(private.report_closed_through(p_client_id), date '1900-01-01') then
    raise exception 'statements after % are not final yet (the period is still open)',
      private.report_closed_through(p_client_id) using errcode = '42501';
  end if;
end;
$$;

-- Status of the periods a report covers (open = preliminary figures).
create function public.report_period_status(p_client_id uuid, p_from date, p_to date)
returns table (period_id uuid, start_date date, end_date date, status public.period_status)
language sql stable security invoker set search_path = '' as $$
  select id, start_date, end_date, status from public.accounting_periods
   where client_id = p_client_id and end_date >= coalesce(p_from, date '1900-01-01') and start_date <= p_to
   order by start_date;
$$;

-- ---------------------------------------------------------------------------
-- Account balances: the single read model behind every statement
-- ---------------------------------------------------------------------------
-- Per account: balance before p_from (debit-minus-credit), period debits and
-- credits (p_from..p_to), and the balance at p_to. p_include_closing = false
-- leaves out year-end closing entries (income statement and cash flow), so a
-- closed year still shows its profit. Amounts are exact text.
create function public.report_account_balances(
  p_client_id uuid, p_from date, p_to date, p_include_closing boolean default true
)
returns table (
  account_id uuid, code text, name text, account_type public.account_type, normal_balance public.normal_balance,
  section text, cash_flow_class text, mapping_is_default boolean,
  opening_net text, period_debit text, period_credit text, closing_net text
)
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform private.require_report_access(p_client_id, p_to);
  if p_to is null or (p_from is not null and p_from > p_to) then
    raise exception 'choose a valid date range' using errcode = '22023';
  end if;
  return query
  with lines as (
    select l.account_id, e.entry_date, l.debit, l.credit
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
     where l.client_id = p_client_id and e.status in ('posted', 'reversed') and e.entry_date <= p_to
       and (p_include_closing or e.entry_type <> 'closing')
  ),
  sums as (
    select lines.account_id,
           coalesce(sum(debit - credit) filter (where p_from is not null and entry_date < p_from), 0) as opening,
           coalesce(sum(debit) filter (where p_from is null or entry_date >= p_from), 0) as dr,
           coalesce(sum(credit) filter (where p_from is null or entry_date >= p_from), 0) as cr
      from lines group by lines.account_id
  )
  select a.id, a.code, a.name, a.account_type, a.normal_balance,
         coalesce(m.section, d.section), case when m.account_id is not null then m.cash_flow_class else d.cash_flow_class end,
         m.account_id is null,
         coalesce(s.opening, 0)::numeric(18, 2)::text, coalesce(s.dr, 0)::numeric(18, 2)::text,
         coalesce(s.cr, 0)::numeric(18, 2)::text,
         (coalesce(s.opening, 0) + coalesce(s.dr, 0) - coalesce(s.cr, 0))::numeric(18, 2)::text
    from public.accounts a
    left join sums s on s.account_id = a.id
    left join public.account_report_mappings m on m.account_id = a.id
    cross join lateral private.default_report_mapping(a.code, a.account_type, a.normal_balance) d
   where a.client_id = p_client_id and (a.is_postable or s.account_id is not null)
   order by a.code;
end;
$$;

-- Ledger detail for drill-down (one account, a date range), with the source
-- document of each entry. Same access rule as the statements.
create function public.report_account_lines(p_client_id uuid, p_account_id uuid, p_from date, p_to date,
                                            p_include_closing boolean default true)
returns table (entry_id uuid, entry_no integer, entry_date date, entry_type public.entry_type, memo text,
               source_type text, source_ref text, line_no smallint, description text, debit text, credit text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform private.require_report_access(p_client_id, p_to);
  return query
  select e.id, e.entry_no, e.entry_date, e.entry_type, e.memo, e.source_type, e.source_ref, l.line_no, l.description,
         l.debit::text, l.credit::text
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where l.client_id = p_client_id and l.account_id = p_account_id and e.status in ('posted', 'reversed')
     and e.entry_date between coalesce(p_from, date '1900-01-01') and p_to
     and (p_include_closing or e.entry_type <> 'closing')
   order by e.entry_date, e.entry_no, l.line_no;
end;
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on function private.report_closed_through(uuid), private.require_report_access(uuid, date),
  private.default_report_mapping(text, public.account_type, public.normal_balance) to authenticated;

revoke execute on function
  public.set_account_report_mapping(uuid, text, text),
  public.report_closed_through(uuid),
  public.report_period_status(uuid, date, date),
  public.report_account_balances(uuid, date, date, boolean),
  public.report_account_lines(uuid, uuid, date, date, boolean)
from public, anon;
grant execute on function
  public.set_account_report_mapping(uuid, text, text),
  public.report_closed_through(uuid),
  public.report_period_status(uuid, date, date),
  public.report_account_balances(uuid, date, date, boolean),
  public.report_account_lines(uuid, uuid, date, date, boolean)
to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261011210000', 'reporting') on conflict (version) do nothing;
