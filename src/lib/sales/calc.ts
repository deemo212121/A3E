/**
 * Display-only mirror of private.compute_sales_line (the DATABASE computes
 * and stores the real amounts). Exact integer arithmetic; per-line rounding
 * to the centavo, half away from zero.
 */

export type TaxClass = "vatable" | "zero_rated" | "exempt" | "not_subject";

export const TAX_CLASSES: { value: TaxClass; label: string }[] = [
  { value: "vatable", label: "VATable" },
  { value: "zero_rated", label: "Zero-rated" },
  { value: "exempt", label: "VAT-exempt" },
  { value: "not_subject", label: "No VAT (non-VAT seller)" },
];

const DEC = /^\d{1,14}(\.\d{1,4})?$/;

/** Parses a decimal string into an integer scaled by 10^scale (no floats). */
function scaled(v: string, scale: number): bigint | null {
  const t = v.trim().replace(/,/g, "");
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  if (f.length > scale) return null;
  return BigInt(w) * 10n ** BigInt(scale) + BigInt((f + "0".repeat(scale)).slice(0, scale));
}

/** a / b rounded half away from zero (a, b >= 0). */
function divRound(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

export interface LineResult {
  lineAmount: bigint; // centavos
  net: bigint;
  vat: bigint;
}

export function computeLine(
  input: { quantity: string; unitPrice: string; discount: string; taxClass: TaxClass },
  pricesIncludeVat: boolean,
  rate: string,
): LineResult | null {
  if (!DEC.test(input.quantity.trim()) || !DEC.test(input.unitPrice.trim().replace(/,/g, "")))
    return null;
  const qty = scaled(input.quantity, 4);
  const price = scaled(input.unitPrice, 4);
  const disc = input.discount.trim() ? scaled(input.discount, 2) : 0n;
  const r = scaled(rate, 6);
  if (qty === null || price === null || disc === null || r === null || qty <= 0n) return null;
  const lineAmount = divRound(qty * price, 1_000_000n) - disc; // 10^8 -> centavos
  if (lineAmount <= 0n) return null;
  if (input.taxClass !== "vatable") return { lineAmount, net: lineAmount, vat: 0n };
  if (pricesIncludeVat) {
    const vat = divRound(lineAmount * r, 1_000_000n + r);
    return { lineAmount, net: lineAmount - vat, vat };
  }
  const vat = divRound(lineAmount * r, 1_000_000n);
  return { lineAmount, net: lineAmount, vat };
}

export function totals(lines: (LineResult | null)[]) {
  const ok = lines.filter((l): l is LineResult => l !== null);
  const net = ok.reduce((s, l) => s + l.net, 0n);
  const vat = ok.reduce((s, l) => s + l.vat, 0n);
  return { net, vat, total: net + vat, valid: ok.length === lines.length && ok.length > 0 };
}
