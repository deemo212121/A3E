import {
  cleanText,
  parseAmount,
  parseDate,
  parseKind,
  parsePartyKind,
  parseTin,
  parseVatStatus,
  type DateFormat,
} from "./normalize";
import { requiredForKind, todayPh } from "./rules";

/**
 * Column mapping for imports: field definitions, header detection, automatic
 * suggestions, and row conversion to the canonical shape the database stores.
 * Pure functions.
 */

export type ImportTarget = "transactions" | "counterparties";

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  synonyms: string[];
}

export const TRANSACTION_FIELDS: FieldDef[] = [
  {
    key: "txn_date",
    label: "Date",
    required: true,
    synonyms: [
      "date",
      "transaction date",
      "doc date",
      "document date",
      "invoice date",
      "or date",
      "si date",
      "petsa",
    ],
  },
  {
    key: "document_ref",
    label: "Invoice / receipt no.",
    synonyms: [
      "si no",
      "si",
      "invoice no",
      "invoice number",
      "inv no",
      "or no",
      "or number",
      "receipt no",
      "receipt number",
      "reference",
      "ref",
      "ref no",
      "si/or/ci",
      "si or ci",
      "document no",
      "doc no",
      "cv no",
      "voucher no",
    ],
  },
  {
    key: "counterparty_name",
    label: "Customer / supplier",
    synonyms: [
      "customer",
      "supplier",
      "account name",
      "payee",
      "name",
      "vendor",
      "client",
      "customer name",
      "supplier name",
      "payee/supplier",
      "sold to",
      "paid to",
    ],
  },
  {
    key: "counterparty_tin",
    label: "TIN",
    synonyms: ["tin", "tin no", "tin number", "bir tin number", "tin #"],
  },
  {
    key: "description",
    label: "Description",
    synonyms: [
      "particulars",
      "particular",
      "description",
      "details",
      "memo",
      "remarks",
      "item",
      "account description",
    ],
  },
  {
    key: "gross_amount",
    label: "Total amount",
    required: true,
    synonyms: [
      "amount",
      "total",
      "gross amount",
      "total amount",
      "invoice amt",
      "invoice amount",
      "cash",
      "gross sales",
      "amount paid",
    ],
  },
  {
    key: "vat_amount_stated",
    label: "VAT as stated on the document",
    synonyms: [
      "vat",
      "input tax",
      "output tax",
      "vat amount",
      "vat input tax",
      "vat output tax",
      "input vat",
      "output vat",
    ],
  },
  {
    key: "withholding_amount_stated",
    label: "Withholding as stated on the document",
    synonyms: ["ewt", "withholding", "withholding tax", "cwt", "tax withheld"],
  },
  {
    key: "kind",
    label: "Type (sale, purchase, ...)",
    synonyms: ["type", "transaction type", "kind"],
  },
  {
    key: "payment_method",
    label: "Payment method",
    synonyms: ["payment method", "mode of payment", "paid via"],
  },
];

export const COUNTERPARTY_FIELDS: FieldDef[] = [
  {
    key: "registered_name",
    label: "Name",
    required: true,
    synonyms: [
      "name",
      "account name",
      "registered name",
      "supplier",
      "customer",
      "company",
      "business name",
      "supplier name",
      "customer name",
    ],
  },
  { key: "tin", label: "TIN", synonyms: ["tin", "tin no", "tin number", "bir tin number"] },
  {
    key: "address",
    label: "Address",
    synonyms: ["address", "business address", "registered address"],
  },
  {
    key: "vat_status",
    label: "VAT status",
    synonyms: ["vat", "vat status", "vat registration", "vat/non vat", "vat/nonvat"],
  },
  { key: "email", label: "Email", synonyms: ["email", "e-mail", "email address"] },
  {
    key: "phone",
    label: "Phone",
    synonyms: ["phone", "contact no", "contact number", "mobile", "telephone"],
  },
  { key: "kind", label: "Customer or supplier", synonyms: ["type", "kind", "category"] },
];

export function fieldsFor(target: ImportTarget): FieldDef[] {
  return target === "transactions" ? TRANSACTION_FIELDS : COUNTERPARTY_FIELDS;
}

export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9/# ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SheetRow {
  rowNumber: number;
  cells: string[];
  numeric?: boolean[];
}

/** Picks the header row: the early row whose cells best match known column names. */
export function detectHeaderRow(rows: SheetRow[]): number {
  const known = new Set([...TRANSACTION_FIELDS, ...COUNTERPARTY_FIELDS].flatMap((f) => f.synonyms));
  let best = 0;
  let bestScore = -1;
  rows.slice(0, 30).forEach((row, i) => {
    const filled = row.cells.filter((c) => c.trim() !== "");
    const textual = filled.filter((c) => /[A-Za-z]/.test(c));
    if (filled.length < 2 || textual.length < filled.length * 0.7) return;
    const matches = filled.filter((c) => known.has(normalizeHeader(c))).length;
    const score = matches * 10 + filled.length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export type ColumnMapping = Record<string, number | null>;

/** Suggests a column for each field from the header names (each column used once). */
export function suggestMapping(headers: string[], target: ImportTarget): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  for (const field of fieldsFor(target)) {
    let idx = normalized.findIndex((h, i) => !used.has(i) && field.synonyms.includes(h));
    if (idx === -1) {
      idx = normalized.findIndex(
        (h, i) =>
          !used.has(i) && h !== "" && field.synonyms.some((s) => s.length > 3 && h.includes(s)),
      );
    }
    mapping[field.key] = idx === -1 ? null : idx;
    if (idx !== -1) used.add(idx);
  }
  return mapping;
}

export interface MappingOptions {
  dateFormat: DateFormat;
  /** Used when no "type" column is mapped. */
  defaultKind: string | null;
  date1904?: boolean;
  today?: string;
}

export interface RowError {
  field: string;
  message: string;
}
export interface RowResult {
  row_no: number;
  normalized: Record<string, string | null> | null;
  errors: RowError[];
}

const PAYMENT_WORDS: Record<string, string> = {
  cash: "cash",
  check: "check",
  cheque: "check",
  bank: "bank_transfer",
  "bank transfer": "bank_transfer",
  online: "bank_transfer",
  gcash: "e_wallet",
  maya: "e_wallet",
  paymaya: "e_wallet",
  "e-wallet": "e_wallet",
  ewallet: "e_wallet",
  "credit card": "credit_card",
  card: "credit_card",
  "on account": "on_account",
  credit: "on_account",
  charge: "on_account",
  other: "other",
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^[0-9+() -]{7,20}$/;

function cents(amount: string): bigint {
  return BigInt(amount.replace(".", ""));
}

export function applyMapping(
  target: ImportTarget,
  rows: SheetRow[],
  mapping: ColumnMapping,
  options: MappingOptions,
): RowResult[] {
  const today = options.today ?? todayPh();
  return rows.map((row): RowResult => {
    const errors: RowError[] = [];
    const cell = (key: string) => {
      const i = mapping[key];
      return i === null || i === undefined ? "" : (row.cells[i] ?? "");
    };
    const isNumeric = (key: string) => {
      const i = mapping[key];
      return i !== null && i !== undefined && Boolean(row.numeric?.[i]);
    };
    const take = <T>(
      field: string,
      label: string,
      r: { ok: true; value: T } | { ok: false; error: string },
    ) => {
      if (r.ok) return r.value;
      errors.push({ field, message: `${label} ${r.error}` });
      return null;
    };
    const label = (key: string) => fieldsFor(target).find((f) => f.key === key)?.label ?? key;

    if (target === "transactions") {
      const kindRaw = cell("kind");
      const kind = kindRaw.trim()
        ? take("kind", label("kind"), parseKind(kindRaw))
        : options.defaultKind;
      if (!kind)
        errors.push({ field: "kind", message: "Choose the transaction type for this import" });
      const txn_date = take(
        "txn_date",
        "Date",
        parseDate(cell("txn_date"), options.dateFormat, {
          numericCell: isNumeric("txn_date"),
          date1904: options.date1904,
        }),
      );
      if (txn_date && txn_date > today)
        errors.push({ field: "txn_date", message: "Date cannot be in the future" });
      const document_ref = take(
        "document_ref",
        label("document_ref"),
        cleanText(cell("document_ref"), 100),
      );
      const counterparty_name = take(
        "counterparty_name",
        label("counterparty_name"),
        cleanText(cell("counterparty_name"), 200),
      );
      const counterparty_tin = take(
        "counterparty_tin",
        "TIN",
        parseTin(cell("counterparty_tin"), { numericCell: isNumeric("counterparty_tin") }),
      );
      const description = take("description", "Description", cleanText(cell("description"), 500));
      const gross_amount = take(
        "gross_amount",
        "Total amount",
        parseAmount(cell("gross_amount"), { numericCell: isNumeric("gross_amount") }),
      );
      const optionalAmount = (key: string, name: string) =>
        cell(key).trim() === ""
          ? null
          : take(key, name, parseAmount(cell(key), { numericCell: isNumeric(key) }));
      const vat = optionalAmount("vat_amount_stated", "VAT");
      const wht = optionalAmount("withholding_amount_stated", "Withholding");
      if (gross_amount && vat && cents(vat) > cents(gross_amount)) {
        errors.push({ field: "vat_amount_stated", message: "VAT cannot be more than the total" });
      }
      if (gross_amount && wht && cents(wht) > cents(gross_amount)) {
        errors.push({
          field: "withholding_amount_stated",
          message: "Withholding cannot be more than the total",
        });
      }
      const payRaw = cell("payment_method").trim().toLowerCase();
      const payment_method = payRaw ? (PAYMENT_WORDS[payRaw] ?? null) : null;
      if (payRaw && !payment_method) {
        errors.push({
          field: "payment_method",
          message: `"${cell("payment_method").trim().slice(0, 30)}" is not a known payment method`,
        });
      }
      if (counterparty_tin && !counterparty_name) {
        errors.push({
          field: "counterparty_name",
          message: "Customer/supplier name is required when a TIN is given",
        });
      }
      if (kind) {
        const need = requiredForKind(kind);
        if (need.counterparty && !counterparty_name && !counterparty_tin) {
          errors.push({ field: "counterparty_name", message: "Customer/supplier is required" });
        }
        if (need.documentRef && !document_ref) {
          errors.push({
            field: "document_ref",
            message: "Invoice/receipt number is required for sales and purchases",
          });
        }
        if (need.description && !description) {
          errors.push({ field: "description", message: "Description is required" });
        }
      }
      return {
        row_no: row.rowNumber,
        normalized: errors.length
          ? null
          : {
              kind,
              txn_date,
              document_ref,
              counterparty_name,
              counterparty_tin,
              description,
              gross_amount,
              vat_amount_stated: vat,
              withholding_amount_stated: wht,
              payment_method,
            },
        errors,
      };
    }

    const kindRaw = cell("kind");
    const kind = kindRaw.trim()
      ? take("kind", label("kind"), parsePartyKind(kindRaw))
      : options.defaultKind;
    if (!kind)
      errors.push({ field: "kind", message: "Choose customer, supplier or both for this import" });
    const registered_name = take(
      "registered_name",
      "Name",
      cleanText(cell("registered_name"), 200),
    );
    if (!registered_name && !errors.some((e) => e.field === "registered_name")) {
      errors.push({ field: "registered_name", message: "Name is required" });
    }
    const tin = take("tin", "TIN", parseTin(cell("tin"), { numericCell: isNumeric("tin") }));
    const vat_status = take("vat_status", "VAT status", parseVatStatus(cell("vat_status")));
    const address = take("address", "Address", cleanText(cell("address"), 500));
    const email = take("email", "Email", cleanText(cell("email"), 254));
    if (email && !EMAIL.test(email))
      errors.push({ field: "email", message: `"${email}" is not a valid email` });
    const phone = take("phone", "Phone", cleanText(cell("phone"), 20));
    if (phone && !PHONE.test(phone))
      errors.push({ field: "phone", message: `"${phone}" is not a valid phone number` });
    return {
      row_no: row.rowNumber,
      normalized: errors.length
        ? null
        : {
            kind,
            registered_name,
            tin,
            vat_status,
            address,
            email: email?.toLowerCase() ?? null,
            phone,
          },
      errors,
    };
  });
}
