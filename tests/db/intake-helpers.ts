/**
 * Helpers for the Phase 6 intake tests (synthetic data only).
 */
import { actor, asUser, asUserCommit, pgErrorCode, type Db, type UserKey } from "./harness";

let seq = 0;
export const newKey = (label = "key") => `${label}-${++seq}-${Date.now()}`.padEnd(12, "x");

export function intake(db: Db) {
  /** Runs SQL as a user and COMMITS; returns the rows. */
  const run = async <T extends Record<string, unknown>>(
    who: UserKey,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> =>
    asUserCommit(db, actor(who), async (tx) => (await tx.query<T>(sql, params)).rows);

  /** Runs SQL as a user (rolled back) and returns the Postgres error code, if any. */
  const errorOf = (who: UserKey, sql: string, params: unknown[] = []) =>
    asUser(db, actor(who), (tx) => pgErrorCode(tx.query(sql, params)));

  /** Returns the error message raised for a user's SQL (rolled back). */
  const messageOf = (who: UserKey, sql: string, params: unknown[] = []) =>
    asUser(db, actor(who), async (tx) => {
      try {
        await tx.query(sql, params);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    });

  /** Reads rows as a user (RLS applies). */
  const read = <T extends Record<string, unknown>>(
    who: UserKey,
    sql: string,
    params: unknown[] = [],
  ) => asUser(db, actor(who), async (tx) => (await tx.query<T>(sql, params)).rows);

  const SAVE_TXN =
    "select public.save_intake_transaction($1, $2, $3, $4::jsonb, $5::jsonb, $6::uuid[], $7) as id";

  async function saveTxn(
    who: UserKey,
    client: string,
    header: Record<string, unknown>,
    opts: { lines?: unknown[]; id?: string; version?: number; docs?: string[]; key?: string } = {},
  ): Promise<string> {
    const rows = await run<{ id: string }>(who, SAVE_TXN, [
      client,
      opts.id ?? null,
      opts.version ?? null,
      JSON.stringify(header),
      JSON.stringify(opts.lines ?? []),
      opts.docs ?? null,
      opts.key ?? newKey("txn"),
    ]);
    return rows[0].id;
  }

  const saveTxnError = (
    who: UserKey,
    client: string,
    header: Record<string, unknown>,
    opts: { lines?: unknown[]; id?: string; version?: number; key?: string } = {},
  ) =>
    errorOf(who, SAVE_TXN, [
      client,
      opts.id ?? null,
      opts.version ?? null,
      JSON.stringify(header),
      JSON.stringify(opts.lines ?? []),
      null,
      opts.key ?? newKey("txn"),
    ]);

  const transitionTxn = (who: UserKey, id: string, to: string, comment: string | null = null) =>
    run(who, "select public.transition_intake_transaction($1, $2::public.intake_status, $3) as s", [
      id,
      to,
      comment,
    ]);

  const transitionTxnError = (
    who: UserKey,
    id: string,
    to: string,
    comment: string | null = null,
  ) =>
    errorOf(who, "select public.transition_intake_transaction($1, $2::public.intake_status, $3)", [
      id,
      to,
      comment,
    ]);

  async function txn(id: string) {
    const { rows } = await db.query<Record<string, unknown>>(
      "select *, gross_amount::text as gross from public.intake_transactions where id = $1",
      [id],
    );
    return rows[0];
  }

  return {
    run,
    errorOf,
    messageOf,
    read,
    saveTxn,
    saveTxnError,
    transitionTxn,
    transitionTxnError,
    txn,
  };
}

/** A complete, valid purchase (synthetic). */
export function purchase(overrides: Record<string, unknown> = {}) {
  return {
    kind: "purchase",
    txn_date: "2026-09-03",
    document_type: "official_receipt",
    document_ref: "OR-1001",
    counterparty_name: "Sample Fuels Corp.",
    counterparty_tin: "111222333000",
    description: "Diesel",
    gross_amount: "2240.00",
    vat_amount_stated: "240.00",
    payment_method: "cash",
    ...overrides,
  };
}
