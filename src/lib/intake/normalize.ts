/**
 * Converts spreadsheet values to the canonical intake formats. Pure functions.
 * Never silently rounds money: more than 2 decimals is an error, except for
 * Excel's binary floating-point noise in NUMBER cells (e.g. 64019.999999999993
 * is 64020.00), which is corrected only when it is within 0.000001.
 */

export type DateFormat = "YMD" | "MDY" | "DMY";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function isoDate(y: number, m: number, d: number): Parsed<string> {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    y < 2000 ||
    y > 2100 ||
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return { ok: false, error: "is not a valid date" };
  }
  return { ok: true, value: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** Excel serial day number to ISO date (1900 or 1904 date system). */
export function excelSerialToIso(serial: number, date1904 = false): Parsed<string> {
  if (!Number.isFinite(serial) || serial < 1 || Math.floor(serial) !== serial) {
    return { ok: false, error: "is not a valid date" };
  }
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const dt = new Date(base + serial * 86_400_000);
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function parseDate(
  raw: string,
  format: DateFormat,
  opts: { numericCell?: boolean; date1904?: boolean } = {},
): Parsed<string> {
  const v = raw.trim();
  if (!v) return { ok: false, error: "is required" };
  if (opts.numericCell && /^\d+(\.0+)?$/.test(v)) return excelSerialToIso(Number(v), opts.date1904);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
  if (m) {
    if (format === "YMD")
      return { ok: false, error: `"${v}" does not match the chosen date format` };
    return format === "MDY" ? isoDate(+m[3], +m[1], +m[2]) : isoDate(+m[3], +m[2], +m[1]);
  }
  // "Sep 3, 2026", "September 03 2026", "3 Sep 2026", "3-Sep-2026"
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(v);
  if (m && MONTHS[m[1].toLowerCase()]) return isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-](\d{4})$/.exec(v);
  if (m && MONTHS[m[2].toLowerCase()]) return isoDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return { ok: false, error: `"${v.slice(0, 30)}" is not a recognized date` };
}

/** Returns a canonical "1234.50" string. */
export function parseAmount(raw: string, opts: { numericCell?: boolean } = {}): Parsed<string> {
  let v = raw.trim();
  if (!v) return { ok: false, error: "is required" };
  v = v.replace(/^(php|₱|p)\s*/i, "").replace(/\s+/g, "");
  if (/^\(.*\)$/.test(v) || v.startsWith("-")) {
    return {
      ok: false,
      error: "cannot be negative (record refunds or returns as their own transaction)",
    };
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(v))
    return { ok: false, error: `"${raw.trim().slice(0, 30)}" is not a valid amount` };
  const [whole, frac = ""] = v.split(".");
  if (frac.length > 2) {
    const n = Number(v);
    const rounded = Math.round(n * 100) / 100;
    if (!opts.numericCell || Math.abs(n - rounded) > 0.000001) {
      return { ok: false, error: `"${raw.trim()}" has more than 2 decimal places` };
    }
    v = rounded.toFixed(2);
  } else {
    v = `${whole.replace(/^0+(?=\d)/, "")}.${frac.padEnd(2, "0")}`;
  }
  if (!/^\d{1,16}\.\d{2}$/.test(v)) return { ok: false, error: "is too large" };
  if (/^0+\.00$/.test(v)) return { ok: false, error: "must be greater than zero" };
  return { ok: true, value: v };
}

/**
 * Finds a TIN in a cell, even with labels around it (e.g. "Non-VAT Reg. TIN:
 * 706-567-954-00001"). Returns digits formatted as 000-000-000[-00000].
 */
export function parseTin(raw: string, opts: { numericCell?: boolean } = {}): Parsed<string | null> {
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  const m = /(?<!\d)(\d{3})[-\s]?(\d{3})[-\s]?(\d{3})(?:[-\s]?(\d{3,5}))?(?!\d)/.exec(v);
  if (!m) {
    return {
      ok: false,
      error: opts.numericCell
        ? `"${v}" is not a valid TIN (if the TIN starts with 0, format the column as Text in Excel)`
        : `"${v.slice(0, 30)}" is not a valid TIN (9 digits plus an optional 3-5 digit branch code)`,
    };
  }
  return { ok: true, value: [m[1], m[2], m[3], m[4]].filter(Boolean).join("-") };
}

export function cleanText(raw: string, max: number): Parsed<string | null> {
  const v = raw.replace(/\s+/g, " ").trim();
  if (!v) return { ok: true, value: null };
  if (v.length > max) return { ok: false, error: `is longer than ${max} characters` };
  return { ok: true, value: v };
}

const KIND_WORDS: Record<string, string> = {
  sale: "sale",
  sales: "sale",
  si: "sale",
  "sales invoice": "sale",
  purchase: "purchase",
  purchases: "purchase",
  expense: "expense",
  expenses: "expense",
  collection: "collection",
  collections: "collection",
  receipt: "collection",
  "cash receipt": "collection",
  payment: "payment",
  payments: "payment",
  disbursement: "payment",
  "cash disbursement": "payment",
  payroll: "payroll",
  inventory: "inventory",
  other: "other",
};

export function parseKind(raw: string): Parsed<string> {
  const k = KIND_WORDS[raw.trim().toLowerCase()];
  return k
    ? { ok: true, value: k }
    : { ok: false, error: `"${raw.trim().slice(0, 30)}" is not a known transaction type` };
}

const PARTY_WORDS: Record<string, string> = {
  customer: "customer",
  client: "customer",
  buyer: "customer",
  supplier: "supplier",
  vendor: "supplier",
  payee: "supplier",
  both: "both",
  "customer and supplier": "both",
};
export function parsePartyKind(raw: string): Parsed<string> {
  const k = PARTY_WORDS[raw.trim().toLowerCase()];
  return k
    ? { ok: true, value: k }
    : { ok: false, error: `"${raw.trim().slice(0, 30)}" is not customer, supplier or both` };
}

export function parseVatStatus(raw: string): Parsed<string> {
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, " ");
  if (!v) return { ok: true, value: "unknown" };
  if (/^(non ?vat|nv|non vat reg(istered)?)/.test(v)) return { ok: true, value: "non_vat" };
  if (/^(vat|v|vat reg(istered)?)$/.test(v)) return { ok: true, value: "vat_registered" };
  return { ok: false, error: `"${raw.trim().slice(0, 30)}" is not VAT or non-VAT` };
}
