import { unzipSync } from "fflate";

import { SheetReadError } from "./csv";

/**
 * Minimal, read-only XLSX reader for imports. It reads the cached VALUES of
 * cells (never evaluates formulas), shared and inline strings, and the
 * workbook's 1900/1904 date system. It refuses DTDs/entities (XML bombs) and
 * enforces row/column/size limits. Call checkFile() on the bytes first.
 *
 * Numbers are returned exactly as stored (e.g. "64019.999999999993"); dates in
 * Excel are numbers (serial days) and are converted only when a column is
 * mapped as a date (see normalize.ts).
 */

export interface XlsxSheet {
  name: string;
  rows: XlsxRow[];
}
export interface XlsxRow {
  /** 1-based row number as shown in Excel. */
  rowNumber: number;
  cells: string[];
  /** Columns whose value is a number cell (dates, amounts, TINs typed as numbers). */
  numeric: boolean[];
}
export interface XlsxWorkbook {
  sheetNames: string[];
  date1904: boolean;
}

const MAX_PART_BYTES = 60 * 1024 * 1024;

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => safeChar(parseInt(h, 16)));
}

function safeChar(code: number): string {
  if (code === 9 || code === 10 || code === 13) return String.fromCharCode(code);
  if (code < 32 || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}

function readParts(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, string> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => wanted(f.name) && f.originalSize <= MAX_PART_BYTES,
    });
  } catch {
    throw new SheetReadError("The spreadsheet could not be read (damaged file).");
  }
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    const xml = new TextDecoder().decode(data);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new SheetReadError("The spreadsheet contains unsupported content.");
    out[name] = xml;
  }
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
}

function textOf(fragment: string): string {
  // Concatenate <t> runs, ignoring phonetic hints (<rPh>).
  const withoutPhonetic = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))
    out += decodeXml(m[1]);
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

interface SheetRef {
  name: string;
  path: string;
}

function workbookInfo(bytes: Uint8Array): { sheets: SheetRef[]; date1904: boolean } {
  const parts = readParts(
    bytes,
    (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels",
  );
  const wb = parts["xl/workbook.xml"];
  const rels = parts["xl/_rels/workbook.xml.rels"];
  if (!wb || !rels) throw new SheetReadError("The spreadsheet is missing its workbook.");
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) {
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      targets.set(id, path);
    }
  }
  const sheets: SheetRef[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name") ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], "r:id");
    const path = rid ? targets.get(rid) : undefined;
    if (path) sheets.push({ name, path });
  }
  const pr = /<workbookPr\b[^>]*>/.exec(wb)?.[0] ?? "";
  const d = attr(pr, "date1904");
  return { sheets, date1904: d === "1" || d === "true" };
}

export function readWorkbook(bytes: Uint8Array): XlsxWorkbook {
  const info = workbookInfo(bytes);
  if (info.sheets.length === 0) throw new SheetReadError("The spreadsheet has no sheets.");
  return { sheetNames: info.sheets.map((s) => s.name), date1904: info.date1904 };
}

/** Reads one sheet (by name; default: the first sheet). */
export function readSheet(
  bytes: Uint8Array,
  sheetName: string | null,
  limits: { maxRows: number; maxCols: number; maxCellChars: number },
): XlsxSheet & { date1904: boolean } {
  const info = workbookInfo(bytes);
  const sheet = sheetName ? info.sheets.find((s) => s.name === sheetName) : info.sheets[0];
  if (!sheet) throw new SheetReadError(`The sheet "${sheetName}" was not found.`);
  const parts = readParts(bytes, (n) => n === sheet.path || n === "xl/sharedStrings.xml");
  const xml = parts[sheet.path];
  if (!xml) throw new SheetReadError("The sheet could not be read.");

  const shared: string[] = [];
  const sst = parts["xl/sharedStrings.xml"];
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const rows: XlsxRow[] = [];
  let nextRow = 1;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rm[0], "r") ?? nextRow);
    nextRow = rowNumber + 1;
    const body = rm[2] ?? "";
    const cells: string[] = [];
    const numeric: boolean[] = [];
    let nextCol = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cm[0];
      const ref = attr(tag, "r");
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      if (col >= limits.maxCols)
        throw new SheetReadError(`A row has more than ${limits.maxCols} columns.`);
      const type = attr(tag, "t") ?? "n";
      const inner = cm[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = textOf(inner);
      else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else if (v !== undefined) value = decodeXml(v);
      if (value.length > limits.maxCellChars) {
        throw new SheetReadError(
          `Cell ${ref ?? ""} is longer than ${limits.maxCellChars} characters.`,
        );
      }
      while (cells.length < col) {
        cells.push("");
        numeric.push(false);
      }
      cells[col] = value;
      numeric[col] = type === "n" && value !== "";
    }
    if (cells.some((c) => c.trim() !== "")) {
      if (rows.length >= limits.maxRows)
        throw new SheetReadError(`The sheet has more than ${limits.maxRows} rows.`);
      rows.push({ rowNumber, cells, numeric });
    }
  }
  return { name: sheet.name, rows, date1904: info.date1904 };
}
