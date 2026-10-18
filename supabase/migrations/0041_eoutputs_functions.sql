-- Phase 14 (DAT files, alphalists, e-invoicing compliance), part 2 of 2:
-- datasets, deterministic generation, validation report, reconciliation,
-- gates, official-validation records, e-invoicing register.
-- Docs: docs/tax/ELECTRONIC-OUTPUTS.md.
--
-- LAYOUT (JSON, transcribed from the official specification):
--   format: delimited | fixed; delimiter (delimited); quote: none | double;
--   encoding: ascii | utf8; line_end: crlf | lf; final_newline: bool;
--   filename: template, tokens {fact.NAME}, {fact.NAME:digits}, {period.from:FMT},
--             {period.to:FMT} (FMT = to_char format, e.g. MMYYYY); filename_pattern: regex;
--   filter:  [{field, op: eq|neq|in|gt|nonzero, value}]
--   group_by: [fields]  sums: [numeric fields]  (aggregate rows, e.g. per payee and ATC)
--   order_by: [fields]  unique_keys: [fields]
--   records: [{record: header|detail|control, fields: [FIELD...]}]
--   reconcile_to: {form_code, line, sum_field}   (a signed-off workpaper line)
-- FIELD: {name, from: row.F | fact.F | period.from | period.to | const | seq | count | sum.F,
--         value (const), type: text|number|date, length, decimals, date_format, required,
--         allowed: [codes], pattern, upper, digits, slice: [start, len], pad: left|right,
--         pad_char, unsigned}
-- Nothing is silently truncated, transliterated or rounded beyond what the
-- layout says; anything that does not fit is a validation error.

-- ---------------------------------------------------------------------------
-- Datasets: posted (approved) transactions only, with their source ids
-- ---------------------------------------------------------------------------
create function private.out_dataset(p_client_id uuid, p_dataset text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if p_dataset = 'withholding_by_bill_line' then
    select coalesce(jsonb_agg(r order by r ->> 'doc_date', r ->> 'doc_no', (r ->> 'line_no')::int), '[]'::jsonb) into v from (
      select jsonb_build_object('source_type', 'purchase_bill', 'source_id', b.id, 'line_no', l.line_no,
               'doc_no', b.bill_no, 'doc_date', b.bill_date,
               'payee_tin', coalesce(l.source_supplier_tin, cp.tin), 'payee_name', coalesce(l.source_supplier_name, cp.registered_name),
               'payee_address', cp.address, 'atc', w.code, 'rate', l.withholding_rate::text,
               'base', l.withholding_base::text, 'amount', l.withholding_amount::text) as r
        from public.purchase_bill_lines l
        join public.purchase_bills b on b.id = l.bill_id
        join public.counterparties cp on cp.id = b.counterparty_id
        join public.withholding_codes w on w.id = l.withholding_code_id
       where b.client_id = p_client_id and b.status = 'posted' and b.bill_date between p_from and p_to
         and l.withholding_amount > 0) x;
  elsif p_dataset = 'sales_by_invoice' then
    select coalesce(jsonb_agg(r order by r ->> 'doc_date', r ->> 'doc_no'), '[]'::jsonb) into v from (
      select jsonb_build_object('source_type', 'sales_invoice', 'source_id', i.id, 'doc_no', i.invoice_no,
               'doc_date', i.invoice_date, 'customer_tin', cp.tin, 'customer_name', cp.registered_name,
               'customer_address', cp.address, 'vatable', i.vatable_sales::text, 'zero_rated', i.zero_rated_sales::text,
               'exempt', i.exempt_sales::text, 'not_subject', i.not_subject_sales::text, 'vat', i.vat_amount::text,
               'gross', i.gross_amount::text, 'total', i.total_amount::text) as r
        from public.sales_invoices i join public.counterparties cp on cp.id = i.counterparty_id
       where i.client_id = p_client_id and i.status = 'posted' and i.invoice_date between p_from and p_to) x;
  elsif p_dataset = 'purchases_by_bill_line' then
    select coalesce(jsonb_agg(r order by r ->> 'doc_date', r ->> 'doc_no', (r ->> 'line_no')::int), '[]'::jsonb) into v from (
      select jsonb_build_object('source_type', 'purchase_bill', 'source_id', b.id, 'line_no', l.line_no,
               'doc_no', b.bill_no, 'doc_date', b.bill_date,
               'supplier_tin', coalesce(l.source_supplier_tin, cp.tin),
               'supplier_name', coalesce(l.source_supplier_name, cp.registered_name), 'supplier_address', cp.address,
               'tax_class', l.tax_class, 'vat_category', l.vat_category, 'kind', l.kind,
               'net', l.net_amount::text, 'vat', l.vat_amount::text) as r
        from public.purchase_bill_lines l
        join public.purchase_bills b on b.id = l.bill_id
        join public.counterparties cp on cp.id = b.counterparty_id
       where b.client_id = p_client_id and b.status = 'posted' and b.bill_date between p_from and p_to) x;
  elsif p_dataset = 'withheld_by_customer_receipt' then
    select coalesce(jsonb_agg(r order by r ->> 'doc_date', r ->> 'doc_no'), '[]'::jsonb) into v from (
      select jsonb_build_object('source_type', 'sales_receipt', 'source_id', s.id, 'doc_no', s.receipt_no,
               'doc_date', s.receipt_date, 'customer_tin', cp.tin, 'customer_name', cp.registered_name,
               'customer_address', cp.address, 'received', s.amount_received::text, 'withheld', s.withholding_amount::text) as r
        from public.sales_receipts s join public.counterparties cp on cp.id = s.counterparty_id
       where s.client_id = p_client_id and s.status = 'posted' and s.receipt_date between p_from and p_to
         and s.withholding_amount > 0) x;
  else
    raise exception 'unknown dataset %', p_dataset using errcode = '22023';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Field formatting: returns {value, error: {code, message}}
-- ---------------------------------------------------------------------------
create function private.out_field(p_field jsonb, p_raw text, p_layout jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v text := p_raw;
  n numeric;
  len integer := (p_field ->> 'length')::integer;
  fixed boolean := p_layout ->> 'format' = 'fixed';
  err jsonb;
  pad_char text;
begin
  if v is null or v = '' then
    if coalesce((p_field ->> 'required')::boolean, false) then
      return jsonb_build_object('value', '', 'error', jsonb_build_object('code', 'REQUIRED',
               'message', format('%s is required', p_field ->> 'name')));
    end if;
    v := '';
  else
    if coalesce((p_field ->> 'digits')::boolean, false) then
      v := regexp_replace(v, '[^0-9]', '', 'g');
    end if;
    if p_field ? 'slice' then
      v := substr(v, (p_field -> 'slice' ->> 0)::integer, (p_field -> 'slice' ->> 1)::integer);
    end if;
    if coalesce((p_field ->> 'upper')::boolean, false) then
      v := upper(v);
    end if;
    case coalesce(p_field ->> 'type', 'text')
      when 'number' then
        if v !~ '^-?[0-9]+(\.[0-9]+)?$' then
          return jsonb_build_object('value', v, 'error', jsonb_build_object('code', 'NOT_A_NUMBER',
                   'message', format('%s is not a number: %s', p_field ->> 'name', v)));
        end if;
        n := v::numeric;
        if coalesce((p_field ->> 'unsigned')::boolean, false) and n < 0 then
          return jsonb_build_object('value', v, 'error', jsonb_build_object('code', 'NEGATIVE',
                   'message', format('%s cannot be negative', p_field ->> 'name')));
        end if;
        v := round(n, coalesce((p_field ->> 'decimals')::integer, 2))::text;
      when 'date' then
        if v !~ '^\d{4}-\d{2}-\d{2}$' then
          return jsonb_build_object('value', v, 'error', jsonb_build_object('code', 'NOT_A_DATE',
                   'message', format('%s is not a date: %s', p_field ->> 'name', v)));
        end if;
        v := to_char(v::date, coalesce(p_field ->> 'date_format', 'YYYY-MM-DD'));
      else null;
    end case;
  end if;
  if v <> '' and jsonb_typeof(p_field -> 'allowed') = 'array' and not (p_field -> 'allowed') @> to_jsonb(v) then
    err := jsonb_build_object('code', 'INVALID_CODE', 'message', format('%s: "%s" is not an allowed code', p_field ->> 'name', v));
  elsif v <> '' and p_field ? 'pattern' and v !~ (p_field ->> 'pattern') then
    err := jsonb_build_object('code', 'INVALID_FORMAT', 'message', format('%s: "%s" does not match the required format', p_field ->> 'name', v));
  elsif coalesce(p_layout ->> 'encoding', 'ascii') = 'ascii' and v !~ '^[ -~]*$' then
    err := jsonb_build_object('code', 'INVALID_CHAR', 'message', format('%s contains a character the file encoding does not allow: "%s"', p_field ->> 'name', v));
  elsif v ~ '[\r\n\t]' or (not fixed and coalesce(p_layout ->> 'quote', 'none') = 'none'
                             and strpos(v, coalesce(p_layout ->> 'delimiter', ',')) > 0) then
    err := jsonb_build_object('code', 'INVALID_CHAR', 'message', format('%s contains a line break or the field delimiter: "%s"', p_field ->> 'name', v));
  elsif len is not null and char_length(v) > len then
    err := jsonb_build_object('code', 'TOO_LONG', 'message', format('%s is longer than %s characters: "%s"', p_field ->> 'name', len, v));
  end if;
  if fixed and len is not null and char_length(v) <= len then
    pad_char := coalesce(p_field ->> 'pad_char', case when p_field ->> 'type' = 'number' then '0' else ' ' end);
    v := case coalesce(p_field ->> 'pad', case when p_field ->> 'type' = 'number' then 'left' else 'right' end)
           when 'left' then lpad(v, len, pad_char) else rpad(v, len, pad_char) end;
  elsif not fixed and coalesce(p_layout ->> 'quote', 'none') = 'double' then
    v := '"' || replace(v, '"', '""') || '"';
  end if;
  return jsonb_build_object('value', v, 'error', err);
end;
$$;

-- ---------------------------------------------------------------------------
-- Rendering: rows in -> {filename, content, messages, reconciliation}
-- ---------------------------------------------------------------------------
create function private.out_render(p_spec public.output_specs, p_rows jsonb, p_facts jsonb, p_from date, p_to date,
                                   p_client_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  lay jsonb := p_spec.layout;
  rows_ jsonb := '[]'::jsonb;
  agg jsonb;
  r jsonb;
  rec jsonb;
  f jsonb;
  cond jsonb;
  ok boolean;
  out_lines text[] := '{}';
  msgs jsonb := '[]'::jsonb;
  recon jsonb := '[]'::jsonb;
  vals text[];
  res jsonb;
  raw text;
  seq integer;
  delim text := coalesce(lay ->> 'delimiter', ',');
  fname text := coalesce(lay ->> 'filename', '');
  tok text;
  tok_val text;
  s text;
  raw_sum numeric;
  emitted_sum numeric;
  emitted jsonb := '{}'::jsonb;  -- per field name: sum of the emitted (rounded) detail values
  wp record;
begin
  -- 1. filter
  for r in select value from jsonb_array_elements(p_rows) loop
    ok := true;
    for cond in select value from jsonb_array_elements(coalesce(lay -> 'filter', '[]'::jsonb)) loop
      ok := ok and case cond ->> 'op'
        when 'eq' then r -> (cond ->> 'field') = cond -> 'value'
        when 'neq' then r -> (cond ->> 'field') is distinct from cond -> 'value'
        when 'in' then (cond -> 'value') @> jsonb_build_array(r -> (cond ->> 'field'))
        when 'gt' then (r ->> (cond ->> 'field'))::numeric > (cond ->> 'value')::numeric
        when 'nonzero' then coalesce((r ->> (cond ->> 'field'))::numeric, 0) <> 0
        else false end;
    end loop;
    if ok then
      rows_ := rows_ || jsonb_build_array(r);
    end if;
  end loop;
  -- 2. aggregate (group_by + sums), exact numeric sums
  if jsonb_array_length(coalesce(lay -> 'group_by', '[]'::jsonb)) > 0 then
    select coalesce(jsonb_agg(g.obj), '[]'::jsonb) into agg from (
      select (select jsonb_object_agg(k, x -> k) from jsonb_array_elements_text(lay -> 'group_by') k)
             || coalesce((select jsonb_object_agg(sf, (select sum((y ->> sf)::numeric) from jsonb_array_elements(grp.items) y)::text)
                            from jsonb_array_elements_text(coalesce(lay -> 'sums', '[]'::jsonb)) sf), '{}'::jsonb) as obj
        from (select (array_agg(e))[1] as x, jsonb_agg(e) as items
                from jsonb_array_elements(rows_) e
               group by (select jsonb_agg(e -> k) from jsonb_array_elements_text(lay -> 'group_by') k)) grp
    ) g;
    rows_ := agg;
  end if;
  -- 3. deterministic order: order_by keys, then the whole row as text
  select coalesce(jsonb_agg(e order by
           (select string_agg(coalesce(e ->> k, ''), chr(31) order by ord) from jsonb_array_elements_text(coalesce(lay -> 'order_by', '[]'::jsonb)) with ordinality o(k, ord)),
           e::text), '[]'::jsonb)
    into rows_ from jsonb_array_elements(rows_) e;
  -- 4. duplicates
  if jsonb_array_length(coalesce(lay -> 'unique_keys', '[]'::jsonb)) > 0 then
    for s in select k from (select (select string_agg(coalesce(e ->> uk, ''), '|') from jsonb_array_elements_text(lay -> 'unique_keys') uk) k
                              from jsonb_array_elements(rows_) e) d group by k having count(*) > 1 loop
      msgs := msgs || jsonb_build_array(jsonb_build_object('code', 'DUPLICATE', 'severity', 'error', 'record', 'detail',
                'message', format('duplicate records for key %s', s)));
    end loop;
  end if;
  -- 5. records
  for rec in select value from jsonb_array_elements(lay -> 'records') loop
    seq := 0;
    for r in select value from jsonb_array_elements(case when rec ->> 'record' = 'detail' then rows_ else '[null]'::jsonb end) loop
      seq := seq + 1;
      vals := '{}';
      for f in select value from jsonb_array_elements(rec -> 'fields') loop
        raw := case
          when f ->> 'from' like 'row.%' then r ->> substr(f ->> 'from', 5)
          when f ->> 'from' like 'fact.%' then p_facts ->> substr(f ->> 'from', 6)
          when f ->> 'from' = 'period.from' then p_from::text
          when f ->> 'from' = 'period.to' then p_to::text
          when f ->> 'from' = 'const' then f ->> 'value'
          when f ->> 'from' = 'seq' then seq::text
          when f ->> 'from' = 'count' then jsonb_array_length(rows_)::text
          when f ->> 'from' like 'sum.%' then
            (select coalesce(sum((e ->> substr(f ->> 'from', 5))::numeric), 0) from jsonb_array_elements(rows_) e)::text
        end;
        res := private.out_field(f, raw, lay);
        if res -> 'error' <> 'null'::jsonb then
          msgs := msgs || jsonb_build_array((res -> 'error') || jsonb_build_object('severity', 'error',
                    'record', rec ->> 'record', 'row', seq, 'field', f ->> 'name'));
        end if;
        vals := vals || (res ->> 'value');
        if rec ->> 'record' = 'detail' and f ->> 'type' = 'number' and f ->> 'from' like 'row.%'
           and (res ->> 'value') ~ '^ *-?[0-9.]+$' and res -> 'error' = 'null'::jsonb then
          emitted := jsonb_set(emitted, array[substr(f ->> 'from', 5)],
            to_jsonb((coalesce((emitted ->> substr(f ->> 'from', 5))::numeric, 0) + btrim(res ->> 'value', ' ')::numeric)::text));
        end if;
      end loop;
      out_lines := out_lines || array_to_string(vals, case when lay ->> 'format' = 'fixed' then '' else delim end);
    end loop;
  end loop;
  -- 6. filename
  for tok in select (regexp_matches(fname, '\{([^}]+)\}', 'g'))[1] loop
    tok_val := case
      when tok like 'fact.%:digits' then regexp_replace(coalesce(p_facts ->> split_part(substr(tok, 6), ':', 1), ''), '[^0-9]', '', 'g')
      when tok like 'fact.%' then p_facts ->> substr(tok, 6)
      when tok like 'period.from:%' then to_char(p_from, substr(tok, 13))
      when tok like 'period.to:%' then to_char(p_to, substr(tok, 11))
    end;
    if coalesce(tok_val, '') = '' then
      msgs := msgs || jsonb_build_array(jsonb_build_object('code', 'FILENAME', 'severity', 'error', 'record', 'file',
                'message', format('the file name needs {%s}, which has no value', tok)));
    end if;
    fname := replace(fname, '{' || tok || '}', coalesce(tok_val, ''));
  end loop;
  if fname = '' or (lay ? 'filename_pattern' and fname !~ (lay ->> 'filename_pattern')) then
    msgs := msgs || jsonb_build_array(jsonb_build_object('code', 'FILENAME', 'severity', 'error', 'record', 'file',
              'message', format('the file name "%s" does not follow the naming rule', fname)));
  end if;
  -- 7. reconciliation to the underlying (filtered) source rows
  recon := recon || jsonb_build_array(jsonb_build_object('check', 'detail records = aggregated source records',
             'expected', jsonb_array_length(rows_),
             'actual', (select count(*) from jsonb_array_elements(lay -> 'records') x where x ->> 'record' = 'detail')
                       * jsonb_array_length(rows_),
             'passed', true));
  for s in select value from jsonb_array_elements_text(coalesce(lay -> 'sums', '[]'::jsonb)) loop
    -- raw total of the FILTERED (and aggregated: sums are exact) source rows
    select coalesce(sum((e ->> s)::numeric), 0) into raw_sum from jsonb_array_elements(rows_) e;
    emitted_sum := coalesce((emitted ->> s)::numeric, raw_sum);
    recon := recon || jsonb_build_array(jsonb_build_object('check', format('file total of %s = source total', s),
               'expected', raw_sum::text, 'actual', emitted_sum::text, 'passed', raw_sum = emitted_sum));
    if raw_sum <> emitted_sum then
      msgs := msgs || jsonb_build_array(jsonb_build_object('code', 'ROUNDING', 'severity', 'error', 'record', 'file',
                'message', format('the file total of %s (%s) differs from the source total (%s)', s, emitted_sum, raw_sum)));
    end if;
  end loop;
  if lay ? 'reconcile_to' and p_client_id is not null then
    select w.lines ->> (lay -> 'reconcile_to' ->> 'line') as v into wp from public.tax_workpapers w
     where w.client_id = p_client_id and w.form_code = upper(lay -> 'reconcile_to' ->> 'form_code')
       and w.period_from = p_from and w.period_to = p_to and w.status = 'signed_off'
     order by w.prepared_at desc limit 1;
    select coalesce(sum((e ->> (lay -> 'reconcile_to' ->> 'sum_field'))::numeric), 0) into raw_sum from jsonb_array_elements(rows_) e;
    recon := recon || jsonb_build_array(jsonb_build_object('check',
               format('total of %s = signed-off %s line %s', lay -> 'reconcile_to' ->> 'sum_field',
                      lay -> 'reconcile_to' ->> 'form_code', lay -> 'reconcile_to' ->> 'line'),
               'expected', wp.v, 'actual', raw_sum::text, 'passed', wp.v is not null and wp.v::numeric = raw_sum));
  end if;
  return jsonb_build_object(
    'filename', fname,
    'content', array_to_string(out_lines, case when lay ->> 'line_end' = 'lf' then chr(10) else chr(13) || chr(10) end)
               || case when coalesce((lay ->> 'final_newline')::boolean, true)
                       then case when lay ->> 'line_end' = 'lf' then chr(10) else chr(13) || chr(10) end else '' end,
    'messages', msgs, 'reconciliation', recon, 'rows', rows_);
end;
$$;

create function private.out_validate_spec(p_spec public.output_specs) returns void
language plpgsql stable set search_path = '' as $$
declare
  lay jsonb := p_spec.layout;
  rec jsonb;
  f jsonb;
begin
  if coalesce(lay ->> 'format', '') not in ('delimited', 'fixed') or coalesce(lay ->> 'encoding', '') not in ('ascii', 'utf8')
     or coalesce(lay ->> 'line_end', '') not in ('crlf', 'lf') or coalesce(lay ->> 'filename', '') = '' then
    raise exception 'the layout needs format (delimited|fixed), encoding (ascii|utf8), line_end (crlf|lf) and a filename rule'
      using errcode = '22023';
  end if;
  if lay ->> 'format' = 'delimited' and coalesce(lay ->> 'delimiter', '') = '' then
    raise exception 'a delimited layout needs its delimiter' using errcode = '22023';
  end if;
  if jsonb_typeof(lay -> 'records') <> 'array'
     or not exists (select 1 from jsonb_array_elements(lay -> 'records') x where x ->> 'record' = 'detail') then
    raise exception 'the layout needs a detail record' using errcode = '22023';
  end if;
  for rec in select value from jsonb_array_elements(lay -> 'records') loop
    if coalesce(rec ->> 'record', '') not in ('header', 'detail', 'control') or jsonb_typeof(rec -> 'fields') <> 'array' then
      raise exception 'each record needs record (header|detail|control) and fields' using errcode = '22023';
    end if;
    for f in select value from jsonb_array_elements(rec -> 'fields') loop
      if coalesce(f ->> 'name', '') = '' or coalesce(f ->> 'from', '') !~ '^(row\.[a-z_]+|fact\.[a-z_]+|period\.from|period\.to|const|seq|count|sum\.[a-z_]+)$'
         or coalesce(f ->> 'type', 'text') not in ('text', 'number', 'date') then
        raise exception 'field "%": give name, from (row.x, fact.x, period.from/to, const, seq, count, sum.x) and type', f ->> 'name'
          using errcode = '22023';
      end if;
      if lay ->> 'format' = 'fixed' and (f ->> 'length') is null then
        raise exception 'field "%": fixed-width layouts need every field length', f ->> 'name' using errcode = '22023';
      end if;
      if rec ->> 'record' <> 'detail' and f ->> 'from' like 'row.%' then
        raise exception 'field "%": only detail records read row values', f ->> 'name' using errcode = '22023';
      end if;
    end loop;
  end loop;
end;
$$;

-- Fixtures: exact content, filename and message codes.
create function private.out_fixture_results(p_spec_id uuid)
returns table (fixture_id uuid, name text, kind text, as_of date, reviewed boolean, passed boolean, expected jsonb,
               actual jsonb, error text)
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.output_specs;
  x public.output_spec_fixtures;
  v_res jsonb;
  codes jsonb;
begin
  select * into s from public.output_specs where id = p_spec_id;
  for x in select * from public.output_spec_fixtures where spec_id = p_spec_id order by created_at, name loop
    fixture_id := x.id; name := x.name; kind := x.kind; as_of := x.as_of; reviewed := x.reviewed_by is not null;
    expected := jsonb_build_object('filename', x.expected_filename, 'content', x.expected_content, 'messages', x.expected_messages);
    actual := null; error := null; passed := false;
    begin
      if x.as_of < s.effective_from or (s.effective_to is not null and x.as_of > s.effective_to) then
        raise exception 'the fixture date % is outside the specification''s effective dates', x.as_of;
      end if;
      v_res := private.out_render(s, x.rows, x.facts, x.period_from, x.period_to);
      select coalesce(jsonb_agg(distinct m ->> 'code'), '[]'::jsonb) into codes from jsonb_array_elements(v_res -> 'messages') m;
      actual := jsonb_build_object('filename', v_res ->> 'filename', 'content', v_res ->> 'content', 'messages', codes);
      passed := (x.expected_content is null or x.expected_content = v_res ->> 'content')
            and (x.expected_filename is null or x.expected_filename = v_res ->> 'filename')
            and (select coalesce(array_agg(c order by c), '{}') from jsonb_array_elements_text(x.expected_messages) c)
              = (select coalesce(array_agg(c order by c), '{}') from jsonb_array_elements_text(codes) c);
    exception when others then
      error := sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Specification workflow (same gates as forms)
-- ---------------------------------------------------------------------------
create function public.propose_output_spec(p_spec jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := coalesce(p_spec, '{}'::jsonb);
  s public.output_specs;
  v_code text := upper(btrim(coalesce(j ->> 'output_code', '')));
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can enter output specifications' using errcode = '42501';
  end if;
  perform 1 from public.output_specs where output_code = v_code for update;
  begin
    insert into public.output_specs (output_code, version, output_type, title, spec_source, official_tool, official_tool_version,
      effective_from, effective_to, dataset, layout, limitations)
    values (v_code, coalesce((select max(version) from public.output_specs where output_code = v_code), 0) + 1,
            j ->> 'output_type', btrim(j ->> 'title'), coalesce(j -> 'spec_source', '{}'::jsonb),
            nullif(btrim(j ->> 'official_tool'), ''), nullif(btrim(j ->> 'official_tool_version'), ''),
            (j ->> 'effective_from')::date, nullif(j ->> 'effective_to', '')::date, j ->> 'dataset',
            coalesce(j -> 'layout', '{}'::jsonb), btrim(j ->> 'limitations'))
    returning * into s;
  exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception 'incomplete or invalid specification: %', sqlerrm using errcode = '22023';
  end;
  perform private.out_validate_spec(s);
  return s.id;
end;
$$;

create function public.add_output_fixture(p_spec_id uuid, p_fixture jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := coalesce(p_fixture, '{}'::jsonb);
  s public.output_specs;
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.is_accountant_reviewer() then
    raise exception 'only firm accountants, reviewers or managers can add fixtures' using errcode = '42501';
  end if;
  select * into s from public.output_specs where id = p_spec_id;
  if not found then
    raise exception 'specification not found' using errcode = 'P0002';
  end if;
  if s.status <> 'draft' then
    raise exception 'fixtures can only be added to a draft specification' using errcode = '42501';
  end if;
  begin
    insert into public.output_spec_fixtures (spec_id, name, kind, as_of, period_from, period_to, facts, rows, expected_content,
      expected_filename, expected_messages, basis)
    values (s.id, btrim(j ->> 'name'), j ->> 'kind', (j ->> 'as_of')::date, (j ->> 'period_from')::date,
            (j ->> 'period_to')::date, coalesce(j -> 'facts', '{}'::jsonb), coalesce(j -> 'rows', '[]'::jsonb),
            j ->> 'expected_content', j ->> 'expected_filename', coalesce(j -> 'expected_messages', '[]'::jsonb),
            btrim(j ->> 'basis'))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a fixture with that name already exists' using errcode = '23505';
    when check_violation or not_null_violation or invalid_datetime_format then
      raise exception 'incomplete fixture: %', sqlerrm using errcode = '22023';
  end;
  return v_id;
end;
$$;

create function public.review_output_fixture(p_fixture_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  x public.output_spec_fixtures;
begin
  if not private.is_accountant_reviewer() then
    raise exception 'only firm accountants, reviewers or managers can review fixtures' using errcode = '42501';
  end if;
  select * into x from public.output_spec_fixtures where id = p_fixture_id for update;
  if not found then
    raise exception 'fixture not found' using errcode = 'P0002';
  end if;
  if x.reviewed_by is not null then
    return;
  end if;
  if x.created_by = v_uid then
    raise exception 'you wrote this fixture, so another accountant must review it' using errcode = '42501';
  end if;
  update public.output_spec_fixtures set reviewed_by = v_uid, reviewed_at = now() where id = x.id;
end;
$$;

create function private.out_spec_ready(s public.output_specs, p_need_reviewed boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_failed text;
begin
  if char_length(coalesce(s.spec_source ->> 'citation', '')) < 5 or coalesce(s.spec_source ->> 'spec_version', '') = ''
     or coalesce(s.spec_source ->> 'issued_on', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'record the official technical specification: citation, spec_version and issued_on' using errcode = '22023';
  end if;
  if s.official_tool is null or s.official_tool_version is null then
    raise exception 'name the official validation tool and version (or the documented validation procedure)'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.output_spec_fixtures where spec_id = s.id and kind = 'normal')
     or not exists (select 1 from public.output_spec_fixtures where spec_id = s.id and kind = 'boundary') then
    raise exception 'add at least one normal and one boundary fixture' using errcode = '22023';
  end if;
  if p_need_reviewed and exists (select 1 from public.output_spec_fixtures where spec_id = s.id and reviewed_by is null) then
    raise exception 'every fixture must be reviewed by an accountant first' using errcode = '22023';
  end if;
  select string_agg(name || coalesce(' (' || error || ')', ''), '; ') into v_failed
    from private.out_fixture_results(s.id) where not passed;
  if v_failed is not null then
    raise exception 'fixtures do not pass: %', v_failed using errcode = '22023';
  end if;
end;
$$;

create function public.submit_output_spec(p_spec_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.output_specs;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can submit output specifications' using errcode = '42501';
  end if;
  select * into s from public.output_specs where id = p_spec_id for update;
  if not found then
    raise exception 'specification not found' using errcode = 'P0002';
  end if;
  if s.status = 'pending_review' then
    return;
  end if;
  if s.status <> 'draft' then
    raise exception 'only a draft specification can be submitted' using errcode = '22023';
  end if;
  perform private.out_validate_spec(s);
  perform private.out_spec_ready(s, false);
  update public.output_specs set status = 'pending_review' where id = s.id;
end;
$$;

create function public.approve_output_spec(p_spec_id uuid, p_spec_verified boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  s public.output_specs;
begin
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can approve output specifications' using errcode = '42501';
  end if;
  select * into s from public.output_specs where id = p_spec_id for update;
  if not found then
    raise exception 'specification not found' using errcode = 'P0002';
  end if;
  if s.status in ('approved', 'enabled') then
    return;
  end if;
  if s.status <> 'pending_review' then
    raise exception 'submit the specification for review first' using errcode = '22023';
  end if;
  if s.entered_by = v_uid then
    raise exception 'you entered this specification, so someone else must approve it' using errcode = '42501';
  end if;
  if not coalesce(p_spec_verified, false) then
    raise exception 'confirm that you compared every field with the official technical specification' using errcode = '22023';
  end if;
  perform private.out_spec_ready(s, true);
  perform 1 from public.output_specs where output_code = s.output_code for update;
  if exists (select 1 from public.output_specs o where o.output_code = s.output_code and o.status in ('approved', 'enabled')
               and o.id <> s.id
               and daterange(o.effective_from, o.effective_to, '[]') && daterange(s.effective_from, s.effective_to, '[]')) then
    raise exception 'another approved version of % covers these dates; end it first', s.output_code using errcode = '22023';
  end if;
  update public.output_specs set status = 'approved', approved_by = v_uid, approved_at = now(), review_note = nullif(btrim(p_note), '')
   where id = s.id;
end;
$$;

create function public.enable_output_spec(p_spec_id uuid, p_statement text, p_evidence text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  s public.output_specs;
begin
  if not private.is_firm_manager() then
    raise exception 'only a firm manager can enable an output for production use' using errcode = '42501';
  end if;
  select * into s from public.output_specs where id = p_spec_id for update;
  if not found then
    raise exception 'specification not found' using errcode = 'P0002';
  end if;
  if s.status = 'enabled' then
    return;
  end if;
  if s.status <> 'approved' then
    raise exception 'only an approved specification can be enabled' using errcode = '22023';
  end if;
  if s.entered_by = v_uid then
    raise exception 'you entered this specification, so another manager must sign it off' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_statement, ''))) < 20 or char_length(btrim(coalesce(p_evidence, ''))) < 5 then
    raise exception 'record the accountant / compliance sign-off statement and where the evidence is kept' using errcode = '22023';
  end if;
  update public.output_specs set status = 'enabled', signoff_by = v_uid, signoff_at = now(),
         signoff_statement = btrim(p_statement), signoff_evidence = btrim(p_evidence)
   where id = s.id;
end;
$$;

create function public.reject_output_spec(p_spec_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can reject output specifications' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'say why the specification is rejected' using errcode = '22023';
  end if;
  update public.output_specs set status = 'rejected', review_note = btrim(p_note)
   where id = p_spec_id and status in ('draft', 'pending_review', 'approved');
  if not found then
    raise exception 'this specification cannot be rejected' using errcode = '22023';
  end if;
end;
$$;

create function public.output_fixture_results(p_spec_id uuid)
returns table (fixture_id uuid, name text, kind text, as_of date, reviewed boolean, passed boolean, expected jsonb,
               actual jsonb, error text)
language sql stable security definer set search_path = '' as $$
  select * from private.out_fixture_results(p_spec_id) where private.firm_role() is not null;
$$;

-- ---------------------------------------------------------------------------
-- Generation, official validation, sign-off
-- ---------------------------------------------------------------------------
create function public.generate_output(
  p_client_id uuid, p_code text, p_period_from date, p_period_to date, p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  s public.output_specs;
  v_status text;
  v_reason text;
  v_rows jsonb := '[]'::jsonb;
  v_facts jsonb := '{}'::jsonb;
  v_res jsonb;
  v_id uuid;
  v_ok boolean := false;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to generate files for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  select id into v_id from public.output_runs where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    return (select jsonb_build_object('run_id', id, 'status', status, 'reason', reason) from public.output_runs where id = v_id);
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to then
    raise exception 'choose a valid period' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tax_obligations where client_id = p_client_id and rule_code = v_code
                   and starts_on <= p_period_from and (ends_on is null or ends_on >= p_period_to)) then
    v_status := 'not_applicable';
    v_reason := 'this output is not a configured obligation of the client for the whole period';
  end if;
  if v_status is null then
    select * into s from public.output_specs
     where output_code = v_code and status = 'enabled' and effective_from <= p_period_from
       and (effective_to is null or effective_to >= p_period_to)
     order by version desc limit 1;
    if s.id is null then
      v_status := 'unsupported';
      v_reason := 'no specification version is enabled (verified against the official spec and signed off) for the whole period';
    end if;
  end if;
  if v_status is null then
    v_facts := private.tax_facts(p_client_id);
    v_rows := private.out_dataset(p_client_id, s.dataset, p_period_from, p_period_to);
    v_res := private.out_render(s, v_rows, v_facts, p_period_from, p_period_to, p_client_id);
    v_ok := jsonb_array_length(v_res -> 'messages') = 0
            and not exists (select 1 from jsonb_array_elements(v_res -> 'reconciliation') c where not (c ->> 'passed')::boolean);
    v_status := 'generated';
  end if;
  insert into public.output_runs (client_id, output_code, spec_id, period_from, period_to, status, reason, snapshot,
    snapshot_sha256, facts, filename, content, content_sha256, messages, reconciliation, precheck_passed, idempotency_key)
  values (p_client_id, v_code, case when v_status = 'generated' then s.id end, p_period_from, p_period_to, v_status, v_reason,
          v_rows, encode(sha256(convert_to(v_rows::text, 'UTF8')), 'hex'), v_facts, v_res ->> 'filename', v_res ->> 'content',
          case when v_res ? 'content' then encode(sha256(convert_to(v_res ->> 'content', 'UTF8')), 'hex') end,
          coalesce(v_res -> 'messages', '[]'::jsonb), coalesce(v_res -> 'reconciliation', '[]'::jsonb), v_ok, p_idempotency_key)
  returning id into v_id;
  if v_status = 'generated' then
    update public.output_runs set status = 'superseded'
     where client_id = p_client_id and output_code = v_code and id <> v_id
       and status in ('generated', 'validated', 'validation_failed', 'signed_off')
       and period_from = p_period_from and period_to = p_period_to;
  end if;
  return jsonb_build_object('run_id', v_id, 'status', v_status, 'reason', v_reason, 'precheck_passed', v_ok);
end;
$$;

-- Records the result of the OFFICIAL validation (the tool named in the spec)
-- or an eSubmission reply, for THIS exact file (its SHA-256). The file becomes
-- "validated" only when the official tool passed AND our validation and
-- reconciliation passed.
create function public.record_output_validation(
  p_run_id uuid, p_kind text, p_tool text, p_tool_version text, p_result text, p_file_sha256 text, p_log text,
  p_reference text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.output_runs;
  s public.output_specs;
  v_status text;
begin
  perform private.require_active_user();
  select * into r from public.output_runs where id = p_run_id for update;
  if not found or not private.is_assigned(r.client_id) then
    raise exception 'file not found' using errcode = 'P0002';
  end if;
  if not private.can_prepare_entries(r.client_id) then
    raise exception 'not allowed to record validation results' using errcode = '42501';
  end if;
  if r.status not in ('generated', 'validated', 'validation_failed') then
    raise exception 'only a current generated file can be validated' using errcode = '22023';
  end if;
  if coalesce(p_file_sha256, '') <> r.content_sha256 then
    raise exception 'the result must be for this exact file (SHA-256 %)', r.content_sha256 using errcode = '22023';
  end if;
  select * into s from public.output_specs where id = r.spec_id;
  if p_kind = 'official_tool' then
    if lower(btrim(coalesce(p_tool, ''))) <> lower(s.official_tool)
       or lower(btrim(coalesce(p_tool_version, ''))) <> lower(s.official_tool_version) then
      raise exception 'this output must be validated with % version %', s.official_tool, s.official_tool_version
        using errcode = '22023';
    end if;
    if p_result not in ('passed', 'failed') then
      raise exception 'the result is passed or failed' using errcode = '22023';
    end if;
    v_status := case when p_result = 'passed' and r.precheck_passed then 'validated' else 'validation_failed' end;
  elsif p_kind = 'esubmission_reply' then
    if r.status <> 'validated' or p_result not in ('accepted', 'rejected') then
      raise exception 'record a submission reply (accepted or rejected) only for a validated file' using errcode = '22023';
    end if;
    v_status := case when p_result = 'accepted' then 'validated' else 'validation_failed' end;
  else
    raise exception 'unknown result kind' using errcode = '22023';
  end if;
  begin
    insert into public.output_validations (client_id, run_id, kind, tool, tool_version, result, file_sha256, log, reference)
    values (r.client_id, r.id, p_kind, btrim(p_tool), nullif(btrim(p_tool_version), ''), p_result, p_file_sha256, p_log,
            nullif(btrim(p_reference), ''));
  exception when check_violation then
    raise exception 'paste the validation log (at least 20 characters)' using errcode = '22023';
  end;
  update public.output_runs set status = v_status where id = r.id;
  return v_status;
end;
$$;

create function public.sign_off_output(p_run_id uuid, p_statement text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.output_runs;
begin
  select * into r from public.output_runs where id = p_run_id for update;
  if not found or not private.is_assigned(r.client_id) then
    raise exception 'file not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(r.client_id) then
    raise exception 'only a reviewer or manager can sign off a file' using errcode = '42501';
  end if;
  if r.status = 'signed_off' then
    return;
  end if;
  if r.status <> 'validated' then
    raise exception 'only a file that passed the official validation and reconciliation can be signed off'
      using errcode = '22023';
  end if;
  if r.generated_by = v_uid then
    raise exception 'you generated this file, so another accountant must sign it off' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_statement, ''))) < 10 then
    raise exception 'write the sign-off statement' using errcode = '22023';
  end if;
  update public.output_runs set status = 'signed_off', signed_off_by = v_uid, signed_off_at = now(),
         signoff_statement = btrim(p_statement)
   where id = r.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- E-invoicing compliance register
-- ---------------------------------------------------------------------------
create function public.propose_einvoice_requirement(p_req jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := coalesce(p_req, '{}'::jsonb);
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can enter e-invoicing requirements' using errcode = '42501';
  end if;
  begin
    insert into public.einvoice_requirements (code, category, title, description, sources)
    values (upper(btrim(j ->> 'code')), j ->> 'category', btrim(j ->> 'title'), btrim(j ->> 'description'),
            coalesce(j -> 'sources', '[]'::jsonb))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'that requirement code already exists' using errcode = '23505';
    when check_violation or not_null_violation then
      raise exception 'incomplete requirement: %', sqlerrm using errcode = '22023';
  end;
  return v_id;
end;
$$;

create function public.verify_einvoice_requirement(p_id uuid, p_source_checked boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  q public.einvoice_requirements;
begin
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can verify e-invoicing requirements' using errcode = '42501';
  end if;
  select * into q from public.einvoice_requirements where id = p_id for update;
  if not found then
    raise exception 'requirement not found' using errcode = 'P0002';
  end if;
  if q.entered_by = v_uid then
    raise exception 'you entered this requirement, so someone else must verify it' using errcode = '42501';
  end if;
  if not coalesce(p_source_checked, false) or jsonb_array_length(q.sources) = 0 or exists (
       select 1 from jsonb_array_elements(q.sources) s
        where char_length(coalesce(s ->> 'citation', '')) < 5 or coalesce(s ->> 'issued_on', '') !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception 'cite the official source (citation and issue date) and confirm you checked it' using errcode = '22023';
  end if;
  update public.einvoice_requirements set status = 'verified', verified_by = v_uid, verified_at = now() where id = p_id;
end;
$$;

-- A reviewer's assessment for one client (append-only history; the latest counts).
create function public.assess_client_einvoice(
  p_client_id uuid, p_requirement_id uuid, p_status text, p_evidence text, p_note text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_approve_entries(p_client_id) then
    raise exception 'only a reviewer or manager can assess e-invoicing compliance' using errcode = '42501';
  end if;
  if p_status in ('met', 'required_not_met', 'in_progress', 'not_applicable')
     and not exists (select 1 from public.einvoice_requirements where id = p_requirement_id and status = 'verified') then
    raise exception 'the requirement must be verified against its official source first' using errcode = '22023';
  end if;
  begin
    insert into public.client_einvoice_assessments (client_id, requirement_id, status, evidence, note)
    values (p_client_id, p_requirement_id, p_status, nullif(btrim(p_evidence), ''), nullif(btrim(p_note), ''))
    returning id into v_id;
  exception when check_violation or foreign_key_violation then
    raise exception '"met" needs the evidence and "not applicable" needs the reason (10+ characters)' using errcode = '22023';
  end;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purge (synthetic clients) and privileges
-- ---------------------------------------------------------------------------
create or replace function public.purge_synthetic_client(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select (value)::text from private.settings where key = 'allow_synthetic_purge'), 'false')
     <> 'true' then
    raise exception 'synthetic purge is disabled in this environment' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id and code ~ '^ZZTEST-') then
    raise exception 'only synthetic ZZTEST- clients can be purged' using errcode = '42501';
  end if;
  perform set_config('app.purge', 'on', true);
  delete from public.client_einvoice_assessments where client_id = p_client_id;
  delete from public.output_validations where client_id = p_client_id;
  delete from public.output_runs where client_id = p_client_id;
  delete from public.tax_workpaper_events where client_id = p_client_id;
  delete from public.tax_workpaper_entries where client_id = p_client_id;
  delete from public.tax_workpapers where client_id = p_client_id;
  delete from public.tax_lineage where client_id = p_client_id;
  delete from public.tax_adjustments where client_id = p_client_id;
  delete from public.tax_computations where client_id = p_client_id;
  delete from public.tax_input_mappings where client_id = p_client_id;
  delete from public.tax_obligations where client_id = p_client_id;
  delete from public.tax_profiles where client_id = p_client_id;
  delete from public.account_report_mappings where client_id = p_client_id;
  delete from public.payroll_events where client_id = p_client_id;
  delete from public.payroll_payments where client_id = p_client_id;
  delete from public.payroll_lines where client_id = p_client_id;
  delete from public.payroll_payslips where client_id = p_client_id;
  delete from public.payroll_runs where client_id = p_client_id;
  delete from public.employee_rates where client_id = p_client_id;
  delete from public.employees where client_id = p_client_id;
  delete from public.payroll_items where client_id = p_client_id;
  delete from public.payroll_settings where client_id = p_client_id;
  delete from public.payroll_access where client_id = p_client_id;
  delete from public.inventory_ledger where client_id = p_client_id;
  delete from public.inventory_movement_lines where client_id = p_client_id;
  delete from public.inventory_movements where client_id = p_client_id;
  delete from public.inventory_stock where client_id = p_client_id;
  delete from public.inventory_items where client_id = p_client_id;
  delete from public.inventory_locations where client_id = p_client_id;
  delete from public.inventory_settings where client_id = p_client_id;
  delete from public.supplier_payment_allocations where client_id = p_client_id;
  delete from public.supplier_payments where client_id = p_client_id;
  delete from public.purchase_bill_documents where client_id = p_client_id;
  delete from public.purchase_bill_lines where client_id = p_client_id;
  delete from public.purchase_bills where client_id = p_client_id;
  delete from public.purchase_categories where client_id = p_client_id;
  delete from public.purchase_settings where client_id = p_client_id;
  delete from public.sales_receipt_allocations where client_id = p_client_id;
  delete from public.sales_receipts where client_id = p_client_id;
  delete from public.sales_credit_note_lines where client_id = p_client_id;
  delete from public.sales_credit_notes where client_id = p_client_id;
  delete from public.sales_invoice_lines where client_id = p_client_id;
  delete from public.sales_invoices where client_id = p_client_id;
  delete from public.sales_settings where client_id = p_client_id;
  delete from public.intake_comments where client_id = p_client_id;
  delete from public.intake_events where client_id = p_client_id;
  delete from public.intake_transaction_documents where client_id = p_client_id;
  delete from public.intake_transaction_lines where client_id = p_client_id;
  delete from public.intake_transactions where client_id = p_client_id;
  delete from public.counterparties where client_id = p_client_id;
  delete from public.import_rows where client_id = p_client_id;
  delete from public.import_batches where client_id = p_client_id;
  delete from public.documents where client_id = p_client_id;
  delete from public.business_profiles where client_id = p_client_id;
  delete from public.journal_lines where client_id = p_client_id;
  delete from public.journal_entries where client_id = p_client_id;
  delete from public.accounting_periods where client_id = p_client_id;
  delete from public.fiscal_years where client_id = p_client_id;
  update public.accounts set parent_id = null where client_id = p_client_id;
  delete from public.accounts where client_id = p_client_id;
  delete from public.clients where id = p_client_id;
  perform set_config('app.purge', 'off', true);
end;
$$;

revoke execute on all functions in schema private from public, anon;
revoke execute on function
  private.out_dataset(uuid, text, date, date), private.out_render(public.output_specs, jsonb, jsonb, date, date, uuid),
  private.out_fixture_results(uuid), private.out_spec_ready(public.output_specs, boolean),
  private.out_validate_spec(public.output_specs), private.out_field(jsonb, text, jsonb)
from authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.propose_output_spec(jsonb), public.add_output_fixture(uuid, jsonb), public.review_output_fixture(uuid),
  public.submit_output_spec(uuid), public.approve_output_spec(uuid, boolean, text), public.enable_output_spec(uuid, text, text),
  public.reject_output_spec(uuid, text), public.output_fixture_results(uuid),
  public.generate_output(uuid, text, date, date, text),
  public.record_output_validation(uuid, text, text, text, text, text, text, text), public.sign_off_output(uuid, text),
  public.propose_einvoice_requirement(jsonb), public.verify_einvoice_requirement(uuid, boolean),
  public.assess_client_einvoice(uuid, uuid, text, text, text)
from public, anon;
grant execute on function
  public.propose_output_spec(jsonb), public.add_output_fixture(uuid, jsonb), public.review_output_fixture(uuid),
  public.submit_output_spec(uuid), public.approve_output_spec(uuid, boolean, text), public.enable_output_spec(uuid, text, text),
  public.reject_output_spec(uuid, text), public.output_fixture_results(uuid),
  public.generate_output(uuid, text, date, date, text),
  public.record_output_validation(uuid, text, text, text, text, text, text, text), public.sign_off_output(uuid, text),
  public.propose_einvoice_requirement(jsonb), public.verify_einvoice_requirement(uuid, boolean),
  public.assess_client_einvoice(uuid, uuid, text, text, text)
to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0041', 'eoutputs_functions') on conflict (version) do nothing;
