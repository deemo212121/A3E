-- Phase 6: link approved intake transactions to the ledger.
--
-- An intake transaction is never posted automatically. Staff book an APPROVED
-- transaction by creating a journal entry with source_type 'intake_transaction'
-- and source_ref = the transaction id. That entry follows the normal
-- maker-checker workflow; only when it is POSTED does the intake transaction
-- become 'posted'. Reversing the entry returns the transaction to 'approved'.
-- The existing one-live-entry-per-source index prevents booking it twice.

create function private.intake_ledger_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_ref uuid;
  v_new_ref uuid;
  v_t public.intake_transactions;
begin
  if private.purge_allowed() then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.source_type = 'intake_transaction'
     and (new.source_type is distinct from old.source_type or new.source_ref is distinct from old.source_ref) then
    -- A draft was re-pointed elsewhere: release the old transaction.
    v_old_ref := old.source_ref::uuid;
    update public.intake_transactions set journal_entry_id = null
     where id = v_old_ref and journal_entry_id = old.id and status = 'approved';
  end if;
  if new.source_type is distinct from 'intake_transaction' then
    return null;
  end if;
  begin
    v_new_ref := new.source_ref::uuid;
  exception when invalid_text_representation then
    raise exception 'the source reference is not a valid intake transaction id' using errcode = '22023';
  end;
  select * into v_t from public.intake_transactions where id = v_new_ref for update;
  if not found or v_t.client_id <> new.client_id then
    raise exception 'intake transaction not found for this client' using errcode = '22023';
  end if;

  if new.status = 'draft' or (tg_op = 'UPDATE' and new.status = 'submitted' and old.status = 'draft') then
    if v_t.status <> 'approved' then
      raise exception 'only APPROVED intake transactions can be booked (this one is %)',
        replace(v_t.status::text, '_', ' ') using errcode = '22023';
    end if;
    update public.intake_transactions set journal_entry_id = new.id where id = v_t.id;
  elsif new.status = 'posted' and (tg_op = 'INSERT' or old.status <> 'posted') then
    if v_t.status <> 'approved' then
      raise exception 'only APPROVED intake transactions can be booked (this one is %)',
        replace(v_t.status::text, '_', ' ') using errcode = '22023';
    end if;
    update public.intake_transactions
       set status = 'posted', journal_entry_id = new.id, posted_at = now(), row_version = row_version + 1
     where id = v_t.id;
    perform private.record_intake_event(v_t.client_id, 'transaction', v_t.id, 'approved', 'posted',
      format('Booked as journal entry %s', new.entry_no));
  elsif new.status = 'void' and tg_op = 'UPDATE' and old.status <> 'void' then
    update public.intake_transactions set journal_entry_id = null
     where id = v_t.id and journal_entry_id = new.id and status = 'approved';
  elsif new.status = 'reversed' and tg_op = 'UPDATE' and old.status = 'posted' then
    update public.intake_transactions
       set status = 'approved', journal_entry_id = null, posted_at = null, row_version = row_version + 1
     where id = v_t.id and journal_entry_id = new.id;
    perform private.record_intake_event(v_t.client_id, 'transaction', v_t.id, 'posted', 'approved',
      format('Journal entry %s was reversed; the transaction must be booked again', new.entry_no));
  end if;
  return null;
end;
$$;

create trigger journal_entries_intake_sync
  after insert or update of status, source_type, source_ref on public.journal_entries
  for each row execute function private.intake_ledger_sync();

-- Synthetic-client purge: delete intake data (leaf first) before the ledger.
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

revoke execute on function private.intake_ledger_sync() from public, anon, authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;
