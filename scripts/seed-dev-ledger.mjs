#!/usr/bin/env node
/**
 * DEV-ONLY: fills "DEMO Sampaguita Trading" (DEMO-A) with a SYNTHETIC ledger so
 * every staff screen has something to review. Uses the same transactions and
 * expected results as docs/accounting/TEST-SCENARIOS.md.
 *
 *   npm run seed:dev-ledger
 *
 * Refuses in production. Skips if DEMO-A already has journal entries.
 * Inserts with the service role; the database triggers still enforce
 * balancing, period rules and immutability.
 */
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

Object.assign(process.env, { NODE_ENV: "development" });
nextEnv.loadEnvConfig(process.cwd(), true);
if (process.env.APP_ENV === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const client = must(await db.from("clients").select("id").eq("code", "DEMO-A").single(), "DEMO-A");
const clientId = client.id;
const { count } = await db
  .from("journal_entries")
  .select("id", { count: "exact", head: true })
  .eq("client_id", clientId);
if (count) {
  console.log(`DEMO-A already has ${count} journal entries; nothing to do.`);
  process.exit(0);
}

const users = must(await db.auth.admin.listUsers({ perPage: 1000 }), "users").users;
const userId = (email) => users.find((u) => u.email === email)?.id;
const preparer = userId("demo.accountant@example.com");
const approver = userId("demo.manager@example.com");
if (!preparer || !approver) throw new Error("Run npm run seed:dev-accounts first.");

// Chart of accounts from the PROPOSED template
let accounts = must(
  await db.from("accounts").select("id, code").eq("client_id", clientId),
  "accounts",
);
if (accounts.length === 0) {
  const tpl = must(
    await db
      .from("coa_template_accounts")
      .select("*")
      .eq("template_code", "PH-SME-V0")
      .order("sort_order"),
    "template",
  );
  must(
    await db.from("accounts").insert(
      tpl.map((t) => ({
        client_id: clientId,
        code: t.code,
        name: t.name,
        account_type: t.account_type,
        normal_balance: t.normal_balance,
        is_postable: t.is_postable,
      })),
    ),
    "insert accounts",
  );
  accounts = must(
    await db.from("accounts").select("id, code").eq("client_id", clientId),
    "accounts",
  );
  for (const t of tpl.filter((x) => x.parent_code)) {
    const parent = accounts.find((a) => a.code === t.parent_code);
    must(
      await db
        .from("accounts")
        .update({ parent_id: parent.id })
        .eq("client_id", clientId)
        .eq("code", t.code),
      "parent",
    );
  }
}
const acct = (code) => accounts.find((a) => a.code === code).id;

// Fiscal year 2026 with 12 monthly periods
let fy = must(
  await db
    .from("fiscal_years")
    .select("id")
    .eq("client_id", clientId)
    .eq("start_date", "2026-01-01")
    .maybeSingle(),
  "fy",
);
if (!fy) {
  fy = must(
    await db
      .from("fiscal_years")
      .insert({ client_id: clientId, start_date: "2026-01-01", end_date: "2026-12-31" })
      .select("id")
      .single(),
    "insert fy",
  );
  const periods = Array.from({ length: 12 }, (_, i) => {
    const start = new Date(Date.UTC(2026, i, 1));
    const end = new Date(Date.UTC(2026, i + 1, 0));
    return {
      client_id: clientId,
      fiscal_year_id: fy.id,
      period_no: i + 1,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
    };
  });
  must(await db.from("accounting_periods").insert(periods), "periods");
}
const periods = must(
  await db
    .from("accounting_periods")
    .select("id, start_date, end_date")
    .eq("fiscal_year_id", fy.id),
  "periods",
);
const periodFor = (date) => periods.find((p) => p.start_date <= date && date <= p.end_date).id;

let nextNo = 1;
async function entry({
  date,
  type = "general",
  memo,
  source,
  lines,
  status = "posted",
  reverses = null,
  preparedBy = preparer,
}) {
  const e = must(
    await db
      .from("journal_entries")
      .insert({
        client_id: clientId,
        fiscal_year_id: fy.id,
        period_id: periodFor(date),
        entry_date: date,
        entry_type: type,
        memo: `DEMO: ${memo}`,
        source_type: source?.[0] ?? null,
        source_ref: source?.[1] ?? null,
        idempotency_key: `demo-seed-${date}-${memo}`.slice(0, 200),
        prepared_by: preparedBy,
        reverses_entry_id: reverses,
      })
      .select("id")
      .single(),
    `entry ${memo}`,
  );
  must(
    await db.from("journal_lines").insert(
      lines.map(([code, debit, credit], i) => ({
        client_id: clientId,
        entry_id: e.id,
        line_no: i + 1,
        account_id: acct(code),
        debit,
        credit,
      })),
    ),
    `lines ${memo}`,
  );
  if (status === "submitted") {
    must(
      await db
        .from("journal_entries")
        .update({ status: "submitted", submitted_at: new Date().toISOString() })
        .eq("id", e.id),
      "submit",
    );
  } else if (status === "posted") {
    must(
      await db
        .from("journal_entries")
        .update({
          status: "posted",
          entry_no: nextNo++,
          approved_by: approver,
          posted_at: new Date().toISOString(),
          submitted_at: new Date().toISOString(),
        })
        .eq("id", e.id),
      `post ${memo}`,
    );
  }
  return e.id;
}

// Scenario S1 (January)
await entry({
  date: "2026-01-01",
  type: "opening",
  memo: "Owner's initial investment",
  lines: [
    ["1020", 500000, 0],
    ["3010", 0, 500000],
  ],
});
await entry({
  date: "2026-01-05",
  memo: "Services billed on account",
  source: ["sales_invoice", "SI-DEMO-0001"],
  lines: [
    ["1100", 120000, 0],
    ["4020", 0, 120000],
  ],
});
await entry({
  date: "2026-01-10",
  memo: "January rent",
  lines: [
    ["6020", 25000, 0],
    ["1020", 0, 25000],
  ],
});
await entry({
  date: "2026-01-15",
  memo: "Equipment, part bank loan",
  lines: [
    ["1500", 150000, 0],
    ["1020", 0, 50000],
    ["2200", 0, 100000],
  ],
});
await entry({
  date: "2026-01-20",
  memo: "Collection from customer",
  source: ["official_receipt", "OR-DEMO-0001"],
  lines: [
    ["1020", 80000, 0],
    ["1100", 0, 80000],
  ],
});
await entry({
  date: "2026-01-25",
  memo: "Utilities accrued",
  lines: [
    ["6030", 4567.89, 0],
    ["2020", 0, 4567.89],
  ],
});
await entry({
  date: "2026-01-31",
  memo: "January salaries",
  lines: [
    ["6010", 60000, 0],
    ["1020", 0, 60000],
  ],
});

// Scenario S2 (February): error, reversal, correction
const wrong = await entry({
  date: "2026-02-03",
  memo: "Supplies (wrong amount)",
  source: ["purchase_invoice", "PI-DEMO-0001"],
  lines: [
    ["6040", 1000, 0],
    ["1020", 0, 1000],
  ],
});
const reversal = await entry({
  date: "2026-02-04",
  type: "reversal",
  memo: "Reversal of JE 8: wrong amount",
  source: ["reversal", wrong],
  reverses: wrong,
  preparedBy: approver,
  lines: [
    ["1020", 1000, 0],
    ["6040", 0, 1000],
  ],
});
must(
  await db
    .from("journal_entries")
    .update({ status: "reversed", reversed_by_entry_id: reversal })
    .eq("id", wrong),
  "mark reversed",
);
await entry({
  date: "2026-02-04",
  memo: "Supplies (corrected)",
  source: ["purchase_invoice", "PI-DEMO-0001"],
  lines: [
    ["6040", 100, 0],
    ["1020", 0, 100],
  ],
});

// Work in progress so the review queue and drafts have something
await entry({
  date: "2026-02-10",
  memo: "Bank charges (awaiting review)",
  status: "submitted",
  lines: [
    ["6070", 250, 0],
    ["1020", 0, 250],
  ],
});
await entry({
  date: "2026-02-12",
  memo: "Office supplies (draft, unbalanced)",
  status: "draft",
  lines: [
    ["6040", 500, 0],
    ["1020", 0, 450],
  ],
});

must(await db.from("fiscal_years").update({ next_entry_no: nextNo }).eq("id", fy.id), "counter");
console.log(`Seeded DEMO-A ledger: ${nextNo - 1} posted entries, 1 awaiting review, 1 draft.`);
