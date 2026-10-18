-- Tour sandbox: sample data for the guided System tour (DEVELOPMENT/STAGING ONLY).
--
-- tour_seed_sandbox() builds a new synthetic client "DEMO Tour Sample Co."
-- (code ZZTEST-TOUR-...) by running the REAL workflow functions, each step as
-- the right demo person (owner submits, accountant prepares, reviewer approves
-- and posts, manager approves and enables), so every record, status, history
-- and notification is exactly what production would produce. Some items are
-- left half-way so the user can do the next step in the real UI.
--
-- Safeguards:
--   * private.settings.allow_tour_sandbox must be true. It is on for
--     development; production sets it to false (deployment plan section 4.6)
--     and the production readiness check fails while it is on.
--   * It only ever acts as accounts on the reserved test domains
--     (@example.com / @example.test), never as a real person.
--   * Everything it creates is labelled TOUR ONLY / synthetic. The tax rule,
--     form, file layout and deadline rule are NOT BIR rules, forms or layouts.
--   * tour_remove_sandbox() deletes a sandbox client (synthetic purge).

insert into private.settings (key, value) values ('allow_tour_sandbox', 'true'::jsonb)
on conflict (key) do nothing;

create function private.tour_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select value::text from private.settings where key = 'allow_tour_sandbox'), 'false') = 'true';
$$;

-- Acts as a demo user for the rest of the transaction (or clears the identity
-- when p_user is null). Refuses anyone outside the reserved test domains.
create function private.tour_as(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return;
  end if;
  if not exists (select 1 from public.profiles where id = p_user and is_active
                   and email ~* '@example\.(com|test)$') then
    raise exception 'the tour only acts as demo accounts' using errcode = '42501';
  end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
end;
$$;

create function private.tour_demo_user(p_role text) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p
    left join public.firm_memberships fm on fm.user_id = p.id
   where p.is_active and p.email ~* '@example\.(com|test)$'
     and case when p_role = 'client_owner' then fm.user_id is null and p.email ~* '^(demo\.)?owner'
              else fm.role::text = p_role end
   order by (p.email ~* '^demo\.') desc, p.email
   limit 1;
$$;

create function public.tour_seed_sandbox() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_caller_claims text := current_setting('request.jwt.claims', true);
  v_caller_sub text := current_setting('request.jwt.claim.sub', true);
  v_mgr uuid; v_rev uuid; v_acc uuid; v_own uuid;
  c uuid;
  v_code text := 'ZZTEST-TOUR-' || to_char(clock_timestamp(), 'MMDDHH24MISS') || '-' || upper(substr(md5(random()::text), 1, 4));
  k text := lower(replace(v_code, 'ZZTEST-TOUR-', 'tour-'));
  m1 date := (date_trunc('month', current_date) - interval '1 month')::date;  -- last month
  m1_end date := (date_trunc('month', current_date) - interval '1 day')::date;
  m0 date := date_trunc('month', current_date)::date;                        -- this month
  fy date := date_trunc('year', (date_trunc('month', current_date) - interval '1 month'))::date;
  acct jsonb;
  v_id uuid; v_id2 uuid; v_txn uuid; v_inv uuid; v_cust uuid; v_cust2 uuid; v_rule uuid; v_form uuid; v_spec uuid;
  v_comp uuid; v_wp uuid; v_run uuid; v_drule uuid; v_filing uuid; v_profile uuid;
  r record;
  v_file text := 'H,123456789000,03/2020' || chr(13) || chr(10)
              || 'D,1,777888999000,SAMPLE HARDWARE INC.,100.00,12.00' || chr(13) || chr(10)
              || 'C,1,100.00,12.00' || chr(13) || chr(10);
  v_src jsonb := '[{"citation": "TOUR ONLY - synthetic sample for the guided tour; not a BIR rule", "issued_on": "2020-01-01"}]';
begin
  perform private.require_active_user();
  if not private.tour_enabled() then
    raise exception 'the tour sandbox is turned off in this environment' using errcode = '42501';
  end if;
  if private.firm_role() is null then
    raise exception 'sign in as a firm user (e.g. the demo manager) to create the tour sample data' using errcode = '42501';
  end if;
  v_mgr := private.tour_demo_user('firm_manager');
  v_rev := private.tour_demo_user('reviewer');
  v_acc := private.tour_demo_user('accountant');
  v_own := private.tour_demo_user('client_owner');
  if v_mgr is null or v_rev is null or v_acc is null or v_own is null then
    raise exception 'the tour needs the demo manager, reviewer, accountant and client owner accounts; run npm run seed:dev-accounts'
      using errcode = '22023';
  end if;

  -- 1. The firm sets up the client and its team -----------------------------
  perform private.tour_as(v_mgr);
  c := public.create_client(v_code, 'DEMO Tour Sample Co. (sample data)');
  update public.clients set status = 'active' where id = c;
  perform public.assign_staff(c, v_rev, 'reviewer');
  perform public.assign_staff(c, v_acc, 'preparer');
  insert into public.client_memberships (client_id, user_id, role, created_by) values (c, v_own, 'client_owner', v_mgr);
  perform public.set_client_service_status(c, 'active', 'Tour sample client (synthetic)');

  perform private.tour_as(v_rev);
  perform public.apply_coa_template(c, 'PH-SME-V0');
  perform public.create_fiscal_year(c, fy);
  if m0 >= (fy + interval '1 year')::date then
    perform public.create_fiscal_year(c, (fy + interval '1 year')::date);
  end if;
  perform public.apply_default_sales_settings(c);
  select jsonb_object_agg(code, id) into acct from public.accounts where client_id = c;

  -- 2. The client completes its profile; the firm approves it ----------------
  perform private.tour_as(v_own);
  v_profile := public.save_business_profile(c, null, null, jsonb_build_object(
    'registered_name', 'DEMO Tour Sample Co.', 'tin', '123456789000', 'rdo_code', '039',
    'business_type', 'corporation', 'vat_status', 'vat_registered',
    'registered_address', '1 Sample Street, Quezon City (synthetic)', 'zip_code', '1100',
    'line_of_business', 'Trading of hardware (sample)', 'fiscal_year_end_month', '12',
    'contact_email', 'tour.sample@example.com'), k || '-profile');
  perform public.transition_business_profile(v_profile, 'submitted');
  perform private.tour_as(v_rev);
  perform public.transition_business_profile(v_profile, 'approved');

  -- 3. Customers and a supplier ----------------------------------------------
  perform private.tour_as(v_acc);
  v_cust := public.save_counterparty(c, null, null,
    '{"kind": "customer", "registered_name": "Tour Hardware Supply", "tin": "777888999000"}', k || '-cp1');
  v_cust2 := public.save_counterparty(c, null, null,
    '{"kind": "customer", "registered_name": "Tour Cafe Corner", "tin": "555666777000"}', k || '-cp2');
  v_id := public.save_counterparty(c, null, null,
    '{"kind": "supplier", "registered_name": "Tour Office Supplies", "tin": "111222333000"}', k || '-cp3');
  foreach v_id2 in array array[v_cust, v_cust2, v_id] loop
    perform public.transition_counterparty(v_id2, 'submitted');
    perform public.transition_counterparty(v_id2, 'approved');
  end loop;

  -- 4. Last month: a sale submitted by the client, reviewed, approved, invoiced,
  --    posted and half collected ------------------------------------------------
  perform private.tour_as(v_own);
  v_txn := public.save_intake_transaction(c, null, null, jsonb_build_object(
    'kind', 'sale', 'txn_date', m1 + 4, 'document_ref', 'SI-TOUR-0001',
    'counterparty_name', 'Tour Hardware Supply', 'gross_amount', '11200.00'), '[]'::jsonb, null, k || '-txn1');
  perform public.transition_intake_transaction(v_txn, 'submitted');
  perform private.tour_as(v_acc);
  perform public.transition_intake_transaction(v_txn, 'reviewed');
  perform private.tour_as(v_rev);
  perform public.transition_intake_transaction(v_txn, 'approved');
  perform private.tour_as(v_acc);
  v_inv := public.save_sales_invoice(c, null, null, jsonb_build_object(
    'counterparty_id', v_cust, 'invoice_no', 'SI-TOUR-0001', 'invoice_date', m1 + 4, 'due_date', m1 + 34,
    'sale_type', 'credit', 'intake_transaction_id', v_txn, 'prices_include_vat', true),
    '[{"description": "Hardware goods (sample)", "quantity": "1", "unit_price": "11200", "tax_class": "vatable"}]',
    k || '-inv1');
  perform public.submit_sales_document('sales_invoice', v_inv);
  perform private.tour_as(v_rev);
  perform public.post_sales_invoice(v_inv);
  perform private.tour_as(v_acc);
  v_id := public.save_sales_receipt(c, null, null, jsonb_build_object(
    'counterparty_id', v_cust, 'receipt_no', 'OR-TOUR-0001', 'receipt_date', m1 + 20, 'payment_method', 'check',
    'deposit_account_id', acct ->> '1020', 'amount_received', '5600.00'),
    jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', '5600.00')), k || '-rc1');
  perform public.submit_sales_document('sales_receipt', v_id);
  perform private.tour_as(v_rev);
  perform public.post_sales_receipt(v_id);

  -- Last month: rent paid, recorded by journal entry and posted
  perform private.tour_as(v_acc);
  v_id := public.save_draft_entry(c, null, m1 + 14, 'general', 'Office rent (sample)', null, null, k || '-je1',
    jsonb_build_array(
      jsonb_build_object('account_id', acct ->> '6020', 'debit', '3000.00', 'credit', ''),
      jsonb_build_object('account_id', acct ->> '1020', 'debit', '', 'credit', '3000.00')));
  perform public.submit_entry(v_id);
  perform private.tour_as(v_rev);
  perform public.approve_and_post(v_id);

  -- Last month is reviewed and soft-closed, so the client can see its statements
  for r in select id from public.accounting_periods where client_id = c and end_date <= m1_end order by start_date loop
    perform public.set_period_status(r.id, 'soft_closed', 'Tour sample: month reviewed');
  end loop;

  -- 5. This month: work waiting for the next person (try these in the tour) ----
  perform private.tour_as(v_own);
  v_txn := public.save_intake_transaction(c, null, null, jsonb_build_object(
    'kind', 'sale', 'txn_date', m0, 'document_ref', 'SI-TOUR-0002',
    'counterparty_name', 'Tour Cafe Corner', 'gross_amount', '2240.00'), '[]'::jsonb, null, k || '-txn2');
  perform public.transition_intake_transaction(v_txn, 'submitted');
  perform private.tour_as(v_acc);
  perform public.transition_intake_transaction(v_txn, 'reviewed');
  perform private.tour_as(v_rev);
  perform public.transition_intake_transaction(v_txn, 'approved');
  perform private.tour_as(v_acc);
  v_id := public.save_sales_invoice(c, null, null, jsonb_build_object(
    'counterparty_id', v_cust2, 'invoice_no', 'SI-TOUR-0002', 'invoice_date', m0, 'due_date', m0 + 30,
    'sale_type', 'credit', 'intake_transaction_id', v_txn, 'prices_include_vat', true),
    '[{"description": "Coffee supplies (sample)", "quantity": "1", "unit_price": "2240", "tax_class": "vatable"}]',
    k || '-inv2');
  perform public.submit_sales_document('sales_invoice', v_id);  -- waiting for a reviewer to post

  perform private.tour_as(v_own);
  v_txn := public.save_intake_transaction(c, null, null, jsonb_build_object(
    'kind', 'purchase', 'txn_date', m0, 'document_type', 'official_receipt', 'document_ref', 'OR-SUP-0101',
    'counterparty_name', 'Tour Office Supplies', 'counterparty_tin', '111222333000',
    'description', 'Printer paper and toner (sample)', 'gross_amount', '1120.00', 'vat_amount_stated', '120.00',
    'payment_method', 'cash'), '[]'::jsonb, null, k || '-txn3');
  perform public.transition_intake_transaction(v_txn, 'submitted');  -- waiting for the accountant's review

  perform private.tour_as(v_acc);
  v_id := public.save_draft_entry(c, null, m0, 'general', 'Electricity bill (sample)', null, null, k || '-je2',
    jsonb_build_array(
      jsonb_build_object('account_id', acct ->> '6030', 'debit', '850.00', 'credit', ''),
      jsonb_build_object('account_id', acct ->> '1020', 'debit', '', 'credit', '850.00')));
  perform public.submit_entry(v_id);  -- waiting for a reviewer to approve and post

  -- 6. Tax: synthetic TOUR ONLY rule, form and file layout (firm-wide; created
  --    once through the real approval gates, then reused) -----------------------
  select id into v_rule from public.tax_rules where code = 'TOUR_SAMPLE_TAX' and status = 'approved' limit 1;
  if v_rule is null then
    perform private.tour_as(v_rev);
    v_rule := public.propose_tax_rule(jsonb_build_object(
      'code', 'TOUR_SAMPLE_TAX', 'name', 'TOUR ONLY sample tax (10% of sales; synthetic, not a BIR rule)',
      'tax_type', 'other', 'effective_from', '2020-01-01',
      'inputs', '[{"name": "sales", "source": "ledger"}]'::jsonb, 'params', '{"rate": "0.10"}'::jsonb,
      'formula', '{"steps": [{"name": "tax", "expr": {"round": {"op": "mul", "args": [{"input": "sales"}, {"param": "rate"}]}}}], "outputs": ["tax"]}'::jsonb,
      'sources', v_src));
    perform private.tour_as(v_acc);
    perform public.add_tax_fixture(v_rule, '{"name": "normal", "kind": "normal", "as_of": "2020-03-01", "basis": "synthetic", "inputs": {"sales": "100"}, "expected": {"tax": "10.00"}}');
    perform public.add_tax_fixture(v_rule, '{"name": "rounding", "kind": "boundary", "as_of": "2020-03-01", "basis": "synthetic", "inputs": {"sales": "0.05"}, "expected": {"tax": "0.01"}}');
    perform private.tour_as(v_rev);
    perform public.submit_tax_rule(v_rule);
    for r in select id from public.tax_rule_fixtures where rule_id = v_rule loop
      perform public.review_tax_fixture(r.id, 'Checked by hand (tour sample)');
    end loop;
    perform private.tour_as(v_mgr);
    perform public.approve_tax_rule(v_rule, true, 'Tour sample: synthetic rule, not a BIR rule');
  end if;

  select id into v_form from public.tax_forms where form_code = 'TOUR_FORM' and status = 'enabled' limit 1;
  if v_form is null then
    perform private.tour_as(v_rev);
    v_form := public.propose_tax_form(jsonb_build_object(
      'form_code', 'TOUR_FORM', 'title', 'TOUR ONLY sample return (synthetic, not a BIR form)',
      'official_version', 'TOUR ONLY', 'frequency', 'monthly', 'effective_from', '2020-01-01', 'effective_to', null,
      'eligibility', '[{"fact": "vat_status", "op": "eq", "value": "vat_registered"}]'::jsonb,
      'definition', '{"lines": [
          {"code": "TIN", "label": "TIN", "kind": "fact", "fact": "tin"},
          {"code": "L1", "label": "Sales", "kind": "tax_input", "rule_code": "TOUR_SAMPLE_TAX", "input": "sales"},
          {"code": "L2", "label": "Tax", "kind": "tax_output", "rule_code": "TOUR_SAMPLE_TAX", "output": "tax"},
          {"code": "L3", "label": "Credits", "kind": "manual"},
          {"code": "L4", "label": "Payable", "kind": "formula", "expr": {"op": "max", "args": [{"op": "sub", "args": [{"input": "L2"}, {"input": "L3"}]}, "0"]}}],
        "schedules": [{"code": "SCH1", "title": "Sales", "rule_code": "TOUR_SAMPLE_TAX", "input": "sales"}],
        "validations": []}'::jsonb,
      'sources', v_src, 'limitations', 'Synthetic tour sample; not a BIR form.'));
    perform private.tour_as(v_acc);
    perform public.add_form_fixture(v_form, '{"basis": "synthetic", "facts": {"vat_status": "vat_registered", "tin": "x"}, "name": "normal", "kind": "normal", "as_of": "2020-03-31", "given": {"TIN": "x", "L1": "100", "L2": "10.00", "L3": "3"}, "expected": {"lines": {"L4": "7.00"}, "messages": []}}');
    perform public.add_form_fixture(v_form, '{"basis": "synthetic", "facts": {"vat_status": "vat_registered", "tin": "x"}, "name": "credits equal tax", "kind": "boundary", "as_of": "2020-03-31", "given": {"TIN": "x", "L1": "100", "L2": "10.00", "L3": "10"}, "expected": {"lines": {"L4": "0.00"}, "messages": []}}');
    perform private.tour_as(v_rev);
    perform public.submit_tax_form(v_form);
    for r in select id from public.tax_form_fixtures where form_id = v_form loop
      perform public.review_form_fixture(r.id);
    end loop;
    perform private.tour_as(v_mgr);
    perform public.approve_tax_form(v_form, true, 'Tour sample: synthetic form, not a BIR form');
    perform public.enable_tax_form(v_form, 'Tour sample: computations checked line by line (synthetic)', 'Tour sample evidence');
  end if;

  select id into v_spec from public.output_specs where output_code = 'TOUR_SLS' and status = 'enabled' limit 1;
  if v_spec is null then
    perform private.tour_as(v_rev);
    v_spec := public.propose_output_spec(jsonb_build_object(
      'output_code', 'TOUR_SLS', 'output_type', 'other', 'title', 'TOUR ONLY sample sales file (synthetic, not a BIR DAT layout)',
      'spec_source', '{"citation": "TOUR ONLY - synthetic layout for the guided tour", "spec_version": "T1", "issued_on": "2020-01-01"}'::jsonb,
      'official_tool', 'TOUR VALIDATOR (synthetic)', 'official_tool_version', '1.0', 'effective_from', '2020-01-01',
      'dataset', 'sales_by_invoice', 'limitations', 'Synthetic tour sample; not a BIR file.',
      'layout', '{"format": "delimited", "delimiter": ",", "quote": "none", "encoding": "ascii", "line_end": "crlf",
        "final_newline": true, "filename": "{fact.tin:digits}S{period.to:MMYYYY}.DAT",
        "filename_pattern": "^[0-9]{12}S[0-9]{6}\\.DAT$", "group_by": ["customer_tin", "customer_name"],
        "sums": ["vatable", "vat"], "order_by": ["customer_tin"], "unique_keys": ["customer_tin"],
        "records": [
          {"record": "header", "fields": [{"name": "type", "from": "const", "value": "H"},
            {"name": "tin", "from": "fact.tin", "digits": true, "length": 12, "required": true, "pattern": "^[0-9]{12}$"},
            {"name": "period", "from": "period.to", "type": "date", "date_format": "MM/YYYY"}]},
          {"record": "detail", "fields": [{"name": "type", "from": "const", "value": "D"}, {"name": "seq", "from": "seq"},
            {"name": "tin", "from": "row.customer_tin", "digits": true, "length": 12, "required": true},
            {"name": "name", "from": "row.customer_name", "upper": true, "length": 20, "required": true},
            {"name": "vatable", "from": "row.vatable", "type": "number", "decimals": 2, "unsigned": true},
            {"name": "vat", "from": "row.vat", "type": "number", "decimals": 2}]},
          {"record": "control", "fields": [{"name": "type", "from": "const", "value": "C"}, {"name": "count", "from": "count"},
            {"name": "vatable", "from": "sum.vatable", "type": "number", "decimals": 2},
            {"name": "vat", "from": "sum.vat", "type": "number", "decimals": 2}]}]}'::jsonb));
    perform private.tour_as(v_acc);
    for r in select * from (values ('normal', 'normal'), ('same rows again', 'boundary')) x(name, kind) loop
      perform public.add_output_fixture(v_spec, jsonb_build_object(
        'basis', 'Hand-worked (synthetic)', 'as_of', '2020-03-31', 'period_from', '2020-03-01', 'period_to', '2020-03-31',
        'facts', '{"tin": "123-456-789-000"}'::jsonb, 'name', r.name, 'kind', r.kind,
        'rows', '[{"customer_tin": "777-888-999-000", "customer_name": "Sample Hardware Inc.", "vatable": "100.00", "vat": "12.00"}]'::jsonb,
        'expected_content', v_file));
    end loop;
    perform private.tour_as(v_rev);
    perform public.submit_output_spec(v_spec);
    for r in select id from public.output_spec_fixtures where spec_id = v_spec loop
      perform public.review_output_fixture(r.id);
    end loop;
    perform private.tour_as(v_mgr);
    perform public.approve_output_spec(v_spec, true, null);
    perform public.enable_output_spec(v_spec, 'Tour sample: layout matches the synthetic spec field by field', 'Tour sample evidence');
  end if;

  -- The client's tax work for last month: computed, reviewed, workpaper signed
  -- off, sales file generated, validated (synthetic validator) and signed off.
  perform private.tour_as(v_acc);
  perform public.set_tax_profile(c, '{"vat_status": "vat_registered", "tin": "123-456-789-000"}');
  perform private.tour_as(v_rev);
  perform public.confirm_tax_profile(c);
  perform private.tour_as(v_acc);
  perform public.add_tax_obligation(c, 'TOUR_SAMPLE_TAX', fy, null, 'Tour sample (synthetic)');
  perform public.add_tax_obligation(c, 'TOUR_FORM', fy, null, 'Tour sample (synthetic)');
  perform public.add_tax_obligation(c, 'TOUR_SLS', fy, null, 'Tour sample (synthetic)');
  perform public.set_tax_input_mapping(c, 'TOUR_SAMPLE_TAX', 'sales', array[(acct ->> '4010')::uuid], 'credit_minus_debit');
  v_comp := (public.compute_tax(c, 'TOUR_SAMPLE_TAX', m1, m1_end, '[]'::jsonb, k || '-tax1') ->> 'computation_id')::uuid;
  perform private.tour_as(v_rev);
  perform public.review_tax_computation(v_comp, 'Tour sample: inputs traced to the ledger');
  perform private.tour_as(v_acc);
  v_wp := (public.prepare_workpaper(c, 'TOUR_FORM', m1, m1_end,
    '[{"line": "L3", "value": "0", "reason": "No credits this month (tour sample)"}]'::jsonb, '[]'::jsonb, k || '-wp1') ->> 'workpaper_id')::uuid;
  perform private.tour_as(v_rev);
  perform public.sign_off_workpaper(v_wp, 'Tour sample: lines checked against the books and schedules');
  perform private.tour_as(v_acc);
  v_run := (public.generate_output(c, 'TOUR_SLS', m1, m1_end, k || '-out1') ->> 'run_id')::uuid;
  perform public.record_output_validation(v_run, 'official_tool', 'TOUR VALIDATOR (synthetic)', '1.0', 'passed',
    (select content_sha256 from public.output_runs where id = v_run), 'Synthetic validator: 0 errors (tour sample)', null);
  perform private.tour_as(v_rev);
  perform public.sign_off_output(v_run, 'Tour sample: checked against the source and the validation log');

  -- 7. Operations: an internal deadline, the filing calendar, a filing waiting
  --    for export and confirmation, a document request and a work item ---------
  select id into v_drule from public.deadline_rules where code = 'TOUR-MONTHLY-RETURN' and status = 'verified' limit 1;
  if v_drule is null then
    perform private.tour_as(v_acc);
    v_drule := public.propose_deadline_rule(jsonb_build_object(
      'code', 'TOUR-MONTHLY-RETURN', 'title', 'TOUR ONLY sample monthly return (synthetic internal deadline)',
      'kind', 'internal', 'form_code', 'TOUR_FORM', 'frequency', 'monthly', 'due_months_after', 1, 'due_day', 20,
      'notes', 'Synthetic tour sample; not a BIR deadline.'));
    perform private.tour_as(v_rev);
    perform public.verify_deadline_rule(v_drule, true, 'Tour sample (synthetic internal deadline)');
  end if;
  perform private.tour_as(v_rev);
  perform public.set_client_deadline(c, v_drule, fy, 12, v_acc, v_rev);
  perform private.tour_as(v_acc);
  perform public.generate_filing_calendar(c, fy, (fy + interval '1 year' - interval '1 day')::date);
  select id into v_filing from public.filings where client_id = c and form_code = 'TOUR_FORM' and period_from = m1;
  perform public.advance_filing(v_filing, 'start', '{}', null);
  perform public.advance_filing(v_filing, 'prepared', jsonb_build_object('workpaper_id', v_wp), null);
  perform public.advance_filing(v_filing, 'submit', '{}', null);
  perform private.tour_as(v_rev);
  perform public.advance_filing(v_filing, 'approve', '{"note": "Tour sample: workpaper and schedule reviewed"}', null);
  -- next: record the export (the validated file), then confirm the actual filing

  perform private.tour_as(v_acc);
  perform public.create_document_request(c, jsonb_build_object(
    'title', 'Bank statement for this month (sample request)', 'category', 'bank_statement',
    'details', 'Please upload the bank statement and attach it here.', 'due_on', current_date + 3), k || '-req1');
  v_id := public.create_work_item(c, jsonb_build_object(
    'kind', 'task', 'title', 'Reconcile the bank account (tour sample)', 'assignee_id', v_acc, 'reviewer_id', v_rev,
    'priority', 'normal', 'due_on', current_date + 5), k || '-work1');
  perform public.transition_work_item(v_id, 'in_progress', null, null);

  -- back to the caller
  perform set_config('request.jwt.claims', coalesce(v_caller_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_caller_sub, ''), true);
  perform audit.log_event('tour.sandbox_created', c, jsonb_build_object('code', v_code));
  return c;
end;
$$;

-- Removes a tour sandbox client and everything in it (synthetic purge).
create function public.tour_remove_sandbox(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_caller_claims text := current_setting('request.jwt.claims', true);
  v_caller_sub text := current_setting('request.jwt.claim.sub', true);
begin
  perform private.require_active_user();
  if not private.tour_enabled() then
    raise exception 'the tour sandbox is turned off in this environment' using errcode = '42501';
  end if;
  if private.firm_role() is null then
    raise exception 'sign in as a firm user to remove tour sample data' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id and code ~ '^ZZTEST-TOUR-') then
    raise exception 'only tour sample clients can be removed here' using errcode = '42501';
  end if;
  perform audit.log_event('tour.sandbox_removed', null, jsonb_build_object('client_id', p_client_id));
  perform private.tour_as(null);  -- the purge runs as maintenance, without an end-user identity
  perform public.purge_synthetic_client(p_client_id);
  perform set_config('request.jwt.claims', coalesce(v_caller_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_caller_sub, ''), true);
end;
$$;

revoke execute on function private.tour_enabled(), private.tour_as(uuid), private.tour_demo_user(text)
  from public, anon, authenticated;
revoke execute on function public.tour_seed_sandbox(), public.tour_remove_sandbox(uuid) from public, anon;
grant execute on function public.tour_seed_sandbox(), public.tour_remove_sandbox(uuid) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0045', 'tour_sandbox') on conflict (version) do nothing;
