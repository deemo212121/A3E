/**
 * CSV reading (RFC 4180): quoted fields, escaped quotes, CR/LF/CRLF line ends,
 * a UTF-8 byte-order mark, and comma/semicolon/tab delimiters. Values are
 * returned as text exactly as written; nothing is evaluated (a cell such as
 * "=SUM(A1)" stays plain text).
 */

export class SheetReadError extends Error {}

/** Decodes bytes as UTF-8, falling back to Windows-1252 for older Excel exports. */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r|\n/) === -1 ? text.length : text.search(/\r|\n/));
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string, limits: { maxRows: number; maxCols: number }): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    if (row.length >= limits.maxCols) {
      throw new SheetReadError(`A row has more than ${limits.maxCols} columns.`);
    }
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (rows.length >= limits.maxRows) {
      throw new SheetReadError(`The file has more than ${limits.maxRows} rows.`);
    }
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      endRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (quoted) throw new SheetReadError("The file has a quoted value that is never closed.");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
