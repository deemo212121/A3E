/**
 * Report date ranges and comparison periods (ISO dates, calendar arithmetic
 * in UTC so no time zone can shift a day).
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Adds months, clamping to the month end (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const d = parse(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const day = Math.min(d.getUTCDate(), lastDay(target.getUTCFullYear(), target.getUTCMonth()));
  return iso(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)));
}
export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
const isMonthStart = (s: string) => s.endsWith("-01");
const isMonthEnd = (s: string) => addDays(s, 1).endsWith("-01");

export type Comparison = "none" | "previous" | "prior_year";

/**
 * The comparison range for [from, to]:
 * - previous: the same length immediately before (whole months when the range
 *   is whole months, e.g. Q3 -> Q2; otherwise the same number of days);
 * - prior_year: the same dates one year earlier (month ends stay month ends).
 */
export function comparisonRange(
  from: string,
  to: string,
  mode: Exclude<Comparison, "none">,
): { from: string; to: string } {
  if (mode === "prior_year") {
    const pTo = addMonths(to, -12);
    return { from: addMonths(from, -12), to: isMonthEnd(to) ? endOfMonth(pTo) : pTo };
  }
  if (isMonthStart(from) && isMonthEnd(to)) {
    const months =
      (parse(to).getUTCFullYear() - parse(from).getUTCFullYear()) * 12 +
      parse(to).getUTCMonth() -
      parse(from).getUTCMonth() +
      1;
    return { from: addMonths(from, -months), to: addDays(from, -1) };
  }
  const days = Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

export function endOfMonth(date: string): string {
  const d = parse(date);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}
