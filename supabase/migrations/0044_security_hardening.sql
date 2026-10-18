-- Phase 16: security hardening and query indexes.
--
-- 1. The synthetic-purge switch (app.purge) disables immutability guards.
--    Before: any session could turn it on with set_config(). API users cannot
--    call set_config through PostgREST, but a database session as an end user
--    (e.g. a leaked connection, SQL editor misuse) could, and then save a draft
--    on an inactive account or rewrite guarded rows through checked functions.
--    Now the switch only works without an end-user identity (service role /
--    maintenance), which is how purge_synthetic_client is granted.
-- 2. Indexes for parent-to-child lookups that had none (found by the
--    Phase 16 catalog scan; see docs/PHASE-16-REPORT.md).
-- 3. NULL-safe authorization checks (see section 3 below).
-- 4. Sequence grants left by platform defaults (section 4).
-- 5. Set-based ledger RLS policies (same rules, faster; section 5).

create or replace function private.purge_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(current_setting('app.purge', true), '') = 'on' and auth.uid() is null;
$$;

-- Parent-to-child lookups (lines, allocations, rows) without an index.
create index if not exists sales_invoice_lines_invoice_idx on public.sales_invoice_lines (invoice_id);
create index if not exists sales_credit_note_lines_note_idx on public.sales_credit_note_lines (credit_note_id);
create index if not exists sales_credit_notes_invoice_idx on public.sales_credit_notes (invoice_id);
create index if not exists sales_receipt_allocations_receipt_idx on public.sales_receipt_allocations (receipt_id);
create index if not exists purchase_bill_lines_bill_idx on public.purchase_bill_lines (bill_id);
create index if not exists supplier_payment_allocations_payment_idx on public.supplier_payment_allocations (payment_id);
create index if not exists intake_transaction_lines_txn_idx on public.intake_transaction_lines (transaction_id);
create index if not exists intake_transaction_documents_txn_idx on public.intake_transaction_documents (transaction_id);
create index if not exists import_rows_batch_idx on public.import_rows (batch_id);
create index if not exists inventory_movement_lines_movement_idx on public.inventory_movement_lines (movement_id);
-- Payroll (0030-0032) is optional; index it only when installed.
do $do$
begin
  if to_regclass('public.payroll_payslips') is not null then
    create index if not exists payroll_payslips_run_idx on public.payroll_payslips (run_id);
    create index if not exists payroll_lines_payslip_idx on public.payroll_lines (payslip_id);
  end if;
end
$do$;
create index if not exists journal_entries_reverses_idx on public.journal_entries (reverses_entry_id)
  where reverses_entry_id is not null;
create index if not exists accounting_periods_fy_idx on public.accounting_periods (fiscal_year_id);
create index if not exists tax_workpaper_entries_wp_idx on public.tax_workpaper_entries (workpaper_id);
create index if not exists tax_workpaper_events_wp_idx on public.tax_workpaper_events (workpaper_id);
create index if not exists output_validations_run_idx on public.output_validations (run_id);
create index if not exists document_request_events_request_idx on public.document_request_events (request_id);

-- ---------------------------------------------------------------------------
-- 3. NULL-safe authorization checks (found by the Phase 16 escalation tests).
--    In SQL, "not (NULL = x or false)" is NULL, and "if NULL" does not raise.
--    ops_activity_report (0043): a user with NO firm role passed the check and
--    could read ANY client's activity report. CRITICAL; fixed here.
--    delete_document (0016): if the uploader's profile was removed, the
--    "own pending upload" branch was NULL instead of false. Low; fixed.
--    tax_check (0037): a formula node such as {"op": null} passed validation.
--    Low (fixtures and approval still apply); fixed.
-- ---------------------------------------------------------------------------
create or replace function public.ops_activity_report(p_client_id uuid, p_from date, p_to date)
returns table (occurred_at timestamptz, actor_id uuid, actor_name text, client_id uuid, client_code text,
               action text, table_name text, row_id text, changed_fields text[])
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.firm_role := private.firm_role();
begin
  perform private.require_active_user();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'choose a range of up to one year' using errcode = '22023';
  end if;
  if p_client_id is not null then
    if not coalesce(v_role = 'firm_manager' or private.can_approve_entries(p_client_id), false) then
      raise exception 'only managers and the client''s reviewers can see its activity' using errcode = '42501';
    end if;
  elsif v_role is null or v_role not in ('firm_admin', 'firm_manager') then
    raise exception 'only firm admins and managers can see firm-wide activity' using errcode = '42501';
  end if;
  perform audit.log_event('ops.activity_report_viewed', p_client_id, jsonb_build_object('from', p_from, 'to', p_to));
  return query
    select e.occurred_at, e.actor_id, coalesce(nullif(p.full_name, ''), p.email), e.client_id, c.code, e.action,
           e.table_name, e.row_id,
           case when e.old_data is not null and e.new_data is not null then
             array(select k from jsonb_object_keys(e.new_data) k
                    where k not in ('updated_at', 'version', 'row_version')
                      and (e.old_data -> k) is distinct from (e.new_data -> k) order by k)
           end
      from audit.events e
      left join public.profiles p on p.id = e.actor_id
      left join public.clients c on c.id = e.client_id
     where e.occurred_at >= p_from and e.occurred_at < p_to + 1
       and (case
              when p_client_id is not null then e.client_id = p_client_id
              when v_role = 'firm_admin' then e.client_id is null
              else true
            end)
     order by e.occurred_at desc, e.id desc
     limit 2000;
end;
$$;

create or replace function public.delete_document(p_document_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found or not private.can_read_client(v_doc.client_id) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if v_doc.deleted_at is not null then
    return;
  end if;
  if not coalesce(private.can_approve_intake(v_doc.client_id)
          or (v_doc.uploaded_by = v_uid and v_doc.review_status = 'pending'
              and private.can_submit_intake(v_doc.client_id)), false) then
    raise exception 'you cannot delete this document' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to delete a document' using errcode = '22023';
  end if;
  if exists (select 1 from public.intake_transaction_documents l
               join public.intake_transactions t on t.id = l.transaction_id
              where l.document_id = p_document_id and t.status not in ('cancelled', 'rejected')) then
    raise exception 'this document is attached to a transaction; detach it or cancel the transaction first'
      using errcode = '22023';
  end if;
  update public.documents
     set deleted_at = now(), deleted_by = v_uid, delete_reason = btrim(p_reason)
   where id = p_document_id;
  perform private.record_intake_event(v_doc.client_id, 'document', p_document_id,
    v_doc.review_status::text, 'deleted', p_reason);
end;
$$;

create or replace function private.tax_check(p_node jsonb, p_inputs text[], p_params jsonb, p_steps text[], p_depth integer default 0)
returns void
language plpgsql immutable set search_path = '' as $$
declare
  a jsonb;
  r jsonb;
  prev numeric := null;
begin
  if p_depth > 40 then
    raise exception 'formula is nested too deeply' using errcode = '22023';
  end if;
  if jsonb_typeof(p_node) in ('string', 'number') then
    perform private.tax_dec(p_node, 'a constant');
    return;
  end if;
  if jsonb_typeof(p_node) <> 'object' then
    raise exception 'invalid formula node: %', p_node using errcode = '22023';
  end if;
  if p_node ? 'input' then
    if not coalesce((p_node ->> 'input') = any (p_inputs), false) then
      raise exception 'formula uses undeclared input %', p_node ->> 'input' using errcode = '22023';
    end if;
  elsif p_node ? 'param' then
    perform private.tax_dec(p_params -> (p_node ->> 'param'), 'parameter ' || (p_node ->> 'param'));
  elsif p_node ? 'ref' then
    if not coalesce((p_node ->> 'ref') = any (p_steps), false) then
      raise exception 'formula refers to step % before it is computed', p_node ->> 'ref' using errcode = '22023';
    end if;
  elsif p_node ? 'op' then
    if not coalesce((p_node ->> 'op') = any (array['add', 'sub', 'mul', 'div', 'min', 'max', 'neg']), false) then
      raise exception 'unknown operation %', p_node ->> 'op' using errcode = '22023';
    end if;
    if jsonb_typeof(p_node -> 'args') <> 'array' or jsonb_array_length(p_node -> 'args') = 0 then
      raise exception 'operation % needs arguments', p_node ->> 'op' using errcode = '22023';
    end if;
    for a in select value from jsonb_array_elements(p_node -> 'args') loop
      perform private.tax_check(a, p_inputs, p_params, p_steps, p_depth + 1);
    end loop;
  elsif p_node ? 'round' then
    if coalesce(p_node ->> 'mode', 'half_away_from_zero') not in ('half_away_from_zero', 'down', 'up')
       or coalesce((p_node ->> 'places')::integer, 2) not between 0 and 6 then
      raise exception 'invalid rounding in the formula' using errcode = '22023';
    end if;
    perform private.tax_check(p_node -> 'round', p_inputs, p_params, p_steps, p_depth + 1);
  elsif p_node ? 'if' then
    if coalesce(p_node -> 'if' ->> 'cmp', '') not in ('gt', 'gte', 'lt', 'lte', 'eq', 'neq')
       or jsonb_array_length(coalesce(p_node -> 'if' -> 'args', '[]'::jsonb)) <> 2
       or not (p_node ? 'then' and p_node ? 'else') then
      raise exception 'an "if" needs cmp, 2 args, then and else' using errcode = '22023';
    end if;
    perform private.tax_check(p_node -> 'if' -> 'args' -> 0, p_inputs, p_params, p_steps, p_depth + 1);
    perform private.tax_check(p_node -> 'if' -> 'args' -> 1, p_inputs, p_params, p_steps, p_depth + 1);
    perform private.tax_check(p_node -> 'then', p_inputs, p_params, p_steps, p_depth + 1);
    perform private.tax_check(p_node -> 'else', p_inputs, p_params, p_steps, p_depth + 1);
  elsif p_node ? 'graduated' then
    if jsonb_typeof(p_params -> (p_node ->> 'table')) <> 'array' or jsonb_array_length(p_params -> (p_node ->> 'table')) = 0 then
      raise exception 'graduated table % is missing', p_node ->> 'table' using errcode = '22023';
    end if;
    for r in select value from jsonb_array_elements(p_params -> (p_node ->> 'table')) loop
      if prev is not null and private.tax_dec(r -> 'over', 'table over') <= prev then
        raise exception 'graduated table % must be in ascending order', p_node ->> 'table' using errcode = '22023';
      end if;
      prev := private.tax_dec(r -> 'over', 'table over');
      perform private.tax_dec(r -> 'fixed', 'table fixed');
      perform private.tax_dec(r -> 'rate', 'table rate');
    end loop;
    perform private.tax_check(p_node -> 'graduated', p_inputs, p_params, p_steps, p_depth + 1);
  else
    raise exception 'unknown formula node: %', p_node using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Sequences: some identity sequences kept the platform's broad default
--    grants (USAGE for anon/authenticated). Harmless (ids are not document
--    numbers) but not needed: inserts run inside definer functions. Revoked.
-- ---------------------------------------------------------------------------
do $do$
declare r record;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind = 'S' and n.nspname in ('public', 'audit', 'private') loop
    execute format('revoke all on sequence %I.%I from anon, authenticated', r.nspname, r.relname);
  end loop;
end
$do$;

-- ---------------------------------------------------------------------------
-- 5. Ledger read performance (Phase 16 query analysis). The journal policies
--    called can_read_line/can_read_entry for EVERY row (several lookups each),
--    so a 10,000-line trial balance took about 1.4 s and grew linearly.
--    Same rules, evaluated once per statement: the clients the caller may read
--    as staff (all for managers) or as a member (posted entries only).
-- ---------------------------------------------------------------------------
create function private.staff_client_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.clients c
   where private.firm_role() = 'firm_manager'
  union
  select a.client_id from public.client_assignments a
   where a.user_id = auth.uid() and private.firm_role() in ('reviewer', 'accountant', 'bookkeeper');
$$;

create function private.member_client_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select cm.client_id from public.client_memberships cm
   where cm.user_id = auth.uid() and private.client_role(cm.client_id) is not null;
$$;

drop policy journal_entries_select on public.journal_entries;
create policy journal_entries_select on public.journal_entries for select to authenticated
  using (client_id in (select private.staff_client_ids())
         or (status in ('posted', 'reversed') and client_id in (select private.member_client_ids())));

drop policy journal_lines_select on public.journal_lines;
create policy journal_lines_select on public.journal_lines for select to authenticated
  using (client_id in (select private.staff_client_ids())
         or (client_id in (select private.member_client_ids())
             and exists (select 1 from public.journal_entries e
                          where e.id = journal_lines.entry_id and e.status in ('posted', 'reversed'))));

revoke execute on function private.staff_client_ids(), private.member_client_ids() from public, anon;
grant execute on function private.staff_client_ids(), private.member_client_ids() to authenticated;

revoke execute on function private.purge_allowed() from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0044', 'security_hardening') on conflict (version) do nothing;
