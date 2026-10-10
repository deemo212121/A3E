/**
 * Money helpers for DISPLAY and form totals. Amounts travel as decimal strings
 * ("1234.50"); arithmetic uses integer centavos (BigInt). No floating point.
 * The database remains the authority on balancing and validation.
 */

const AMOUNT_RE = /^\d{1,16}(\.\d{1,2})?$/;

export function isValidAmount(value: string): boolean {
  return AMOUNT_RE.test(value);
}

/** "1234.5" -> 123450n. Empty -> 0n. Throws on invalid input. */
export function toCentavos(value: string): bigint {
  if (value === "") return 0n;
  if (!AMOUNT_RE.test(value)) throw new Error(`invalid amount: ${value}`);
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
}

/** 123450n -> "1234.50" (negative values keep a leading "-"). */
export function fromCentavos(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** "1234567.5" -> "1,234,567.50"; accepts optional leading "-". */
export function formatAmount(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const negative = value.startsWith("-");
  const [whole, frac = ""] = (negative ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${(frac + "00").slice(0, 2)}`;
}

/** Sum of decimal strings, exact. */
export function sumAmounts(values: readonly string[]): string {
  return fromCentavos(values.reduce((acc, v) => acc + toCentavos(v), 0n));
}
