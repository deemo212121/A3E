-- Money must never pass through floating point (doc 05 §7). PostgREST encodes
-- numeric as a JSON number, which JavaScript parses as a float, so the read
-- models now return amounts as exact decimal TEXT (e.g. '445000.00').
drop function public.trial_balance(uuid, date);
drop function public.general_ledger(uuid, uuid, date, date);

create function public.trial_balance(p_client_id uuid, p_as_of date)
returns table (
  account_id uuid, code text, name text, account_type public.account_type,
  normal_balance public.normal_balance, total_debit text, total_credit text, balance text
)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.code, a.name, a.account_type, a.normal_balance,
         sum(l.debit)::numeric(18, 2)::text,
         sum(l.credit)::numeric(18, 2)::text,
         (case when a.normal_balance = 'debit' then sum(l.debit) - sum(l.credit)
               else sum(l.credit) - sum(l.debit) end)::numeric(18, 2)::text
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where l.client_id = p_client_id
     and e.status in ('posted', 'reversed')
     and e.entry_date <= p_as_of
   group by a.id, a.code, a.name, a.account_type, a.normal_balance
   order by a.code;
$$;

create function public.general_ledger(p_client_id uuid, p_account_id uuid, p_from date, p_to date)
returns table (
  entry_id uuid, entry_no integer, entry_date date, entry_type public.entry_type, memo text,
  line_no smallint, description text, debit text, credit text, running_balance text
)
language sql stable security invoker set search_path = '' as $$
  with acct as (
    select normal_balance from public.accounts where id = p_account_id and client_id = p_client_id
  ),
  opening as (
    select coalesce(sum(case when acct.normal_balance = 'debit' then l.debit - l.credit
                             else l.credit - l.debit end), 0) as bal
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      cross join acct
     where l.client_id = p_client_id and l.account_id = p_account_id
       and e.status in ('posted', 'reversed') and e.entry_date < p_from
  ),
  rows as (
    select e.id, e.entry_no, e.entry_date, e.entry_type, e.memo, l.line_no, l.description,
           l.debit, l.credit,
           case when acct.normal_balance = 'debit' then l.debit - l.credit
                else l.credit - l.debit end as delta
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      cross join acct
     where l.client_id = p_client_id and l.account_id = p_account_id
       and e.status in ('posted', 'reversed') and e.entry_date between p_from and p_to
  )
  select r.id, r.entry_no, r.entry_date, r.entry_type, r.memo, r.line_no, r.description,
         r.debit::text, r.credit::text,
         ((select bal from opening)
           + sum(r.delta) over (order by r.entry_date, r.entry_no, r.line_no
                                rows between unbounded preceding and current row))::numeric(18, 2)::text
    from rows r
   order by r.entry_date, r.entry_no, r.line_no;
$$;

revoke execute on function public.trial_balance(uuid, date) from public, anon;
revoke execute on function public.general_ledger(uuid, uuid, date, date) from public, anon;
grant execute on function public.trial_balance(uuid, date) to authenticated;
grant execute on function public.general_ledger(uuid, uuid, date, date) to authenticated;
