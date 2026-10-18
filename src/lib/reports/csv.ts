/**
 * CSV export. Cells are quoted when needed, and text that a spreadsheet would
 * run as a formula (=, +, -, @, tab, CR at the start) is prefixed with an
 * apostrophe, except plain numbers such as "-1234.50".
 */
const BOM = String.fromCharCode(0xfeff);
const NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: string | number | bigint | null | undefined): string {
  let v = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(v) && !NUMBER.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(
  rows: readonly (readonly (string | number | bigint | null | undefined)[])[],
): string {
  // BOM so spreadsheet apps read UTF-8 (₱, ñ) correctly; CRLF per RFC 4180.
  return `${BOM}${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
