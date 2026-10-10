import { readFileSync } from "node:fs";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { decodeText, parseCsv, SheetReadError } from "./csv";
import { applyMapping, detectHeaderRow, suggestMapping, type SheetRow } from "./mapping";
import { excelSerialToIso, parseAmount, parseDate, parseTin } from "./normalize";
import { readSheet, readWorkbook } from "./xlsx";

const LIMITS = { maxRows: 5001, maxCols: 100 };
const XLSX = new Uint8Array(
  readFileSync(join(process.cwd(), "tests/fixtures/synthetic-books.xlsx")),
);

describe("CSV", () => {
  it("handles quotes, escaped quotes, CRLF and embedded newlines", () => {
    const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n1,2,3', LIMITS);
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "line1\nline2"],
      ["1", "2", "3"],
    ]);
  });

  it("detects semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2", LIMITS)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2", LIMITS)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps formulas as plain text (never evaluated)", () => {
    expect(parseCsv('=HYPERLINK("http://x"),+1+1,@SUM(A1)', LIMITS)).toEqual([
      ['=HYPERLINK("http://x")', "+1+1", "@SUM(A1)"],
    ]);
  });

  it("decodes UTF-8 with BOM and falls back to Windows-1252", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x50, 0xc3, 0xb1]))).toBe("Pñ");
    expect(decodeText(new Uint8Array([0x50, 0xf1, 0x6f]))).toBe("Pño");
  });

  it("enforces row/column limits and rejects unterminated quotes", () => {
    expect(() => parseCsv("a\n".repeat(11), { maxRows: 10, maxCols: 5 })).toThrow(SheetReadError);
    expect(() => parseCsv("a,b,c,d,e,f", { maxRows: 10, maxCols: 5 })).toThrow(/columns/);
    expect(() => parseCsv('a,"unterminated', LIMITS)).toThrow(/never closed/);
  });
});

describe("XLSX (fixture written by an independent library)", () => {
  it("lists sheets and reads cached values, strings with entities, and numbers exactly", () => {
    expect(readWorkbook(XLSX)).toEqual({ sheetNames: ["CDJ", "Suppliers"], date1904: false });
    const sheet = readSheet(XLSX, null, { maxRows: 100, maxCols: 100, maxCellChars: 2000 });
    expect(sheet.name).toBe("CDJ");
    const byRow = new Map(sheet.rows.map((r) => [r.rowNumber, r]));
    expect([...byRow.keys()]).toEqual([1, 2, 4, 5, 6, 7, 9]); // blank rows skipped, numbers kept
    expect(byRow.get(4)?.cells).toEqual([
      "DATE",
      "SI/OR/CI",
      "ACCOUNT NAME",
      "TIN NO.",
      "PARTICULAR",
      "CASH",
    ]);
    expect(byRow.get(7)?.cells.slice(2, 6)).toEqual([
      "Sample Steel & Co. <Ltd>",
      "Non-VAT Reg. TIN: 706-567-954-00001",
      'Coil "A"',
      "200",
    ]);
    expect(byRow.get(6)?.numeric[3]).toBe(true); // TIN typed as a number
    expect(byRow.get(5)?.numeric[0]).toBe(true); // a real Excel date is a number
  });

  it("reads another sheet by name and refuses unknown sheets", () => {
    const s = readSheet(XLSX, "Suppliers", { maxRows: 10, maxCols: 10, maxCellChars: 100 });
    expect(s.rows[1].cells).toEqual(["Sample Fuels Corp.", "004-984-946-00000", "VAT"]);
    expect(() => readSheet(XLSX, "Nope", { maxRows: 10, maxCols: 10, maxCellChars: 100 })).toThrow(
      /not found/,
    );
  });

  it("refuses DTD/entity tricks and enforces limits", () => {
    const evil = zipSync({
      "xl/workbook.xml": strToU8(
        '<!DOCTYPE x [<!ENTITY a "aaaa">]><workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData/></worksheet>"),
    });
    expect(() => readWorkbook(evil)).toThrow(/unsupported/);
    expect(() => readSheet(XLSX, null, { maxRows: 3, maxCols: 100, maxCellChars: 100 })).toThrow(
      /more than 3 rows/,
    );
    expect(() => readSheet(XLSX, null, { maxRows: 100, maxCols: 3, maxCellChars: 100 })).toThrow(
      /columns/,
    );
  });
});

describe("value conversion", () => {
  it("dates: ISO, chosen numeric format, month names, Excel serials; invalid dates refused", () => {
    expect(parseDate("2026-09-03", "MDY")).toEqual({ ok: true, value: "2026-09-03" });
    expect(parseDate("09/08/2026", "MDY")).toEqual({ ok: true, value: "2026-09-08" });
    expect(parseDate("09/08/2026", "DMY")).toEqual({ ok: true, value: "2026-08-09" });
    expect(parseDate("Sep 3, 2026", "MDY")).toEqual({ ok: true, value: "2026-09-03" });
    expect(parseDate("3-Sep-2026", "DMY")).toEqual({ ok: true, value: "2026-09-03" });
    expect(parseDate("46268", "MDY", { numericCell: true })).toEqual({
      ok: true,
      value: "2026-09-03",
    });
    expect(excelSerialToIso(44805, true)).toEqual({ ok: true, value: "2026-09-02" });
    expect(parseDate("02/30/2026", "MDY").ok).toBe(false);
    expect(parseDate("46268", "MDY").ok).toBe(false); // a number typed as text is not a date
    expect(parseDate("TOTAL", "MDY").ok).toBe(false);
  });

  it("amounts: separators and peso signs; never silently rounded; float noise fixed only in number cells", () => {
    expect(parseAmount("₱ 1,234.5")).toEqual({ ok: true, value: "1234.50" });
    expect(parseAmount("PHP 2240")).toEqual({ ok: true, value: "2240.00" });
    expect(parseAmount("64019.999999999993", { numericCell: true })).toEqual({
      ok: true,
      value: "64020.00",
    });
    expect(parseAmount("64019.999999999993").ok).toBe(false);
    expect(parseAmount("10.555", { numericCell: true }).ok).toBe(false);
    expect(parseAmount("(500.00)").ok).toBe(false);
    expect(parseAmount("-5").ok).toBe(false);
    expect(parseAmount("0").ok).toBe(false);
    expect(parseAmount("1,23").ok).toBe(false);
    expect(parseAmount("1e5").ok).toBe(false);
  });

  it("TINs: found inside labels, normalized; leading-zero loss reported", () => {
    expect(parseTin("Non-VAT Reg. TIN: 706-567-954-00001")).toEqual({
      ok: true,
      value: "706-567-954-00001",
    });
    expect(parseTin("004984946000")).toEqual({ ok: true, value: "004-984-946-000" });
    expect(parseTin("123 456 789")).toEqual({ ok: true, value: "123-456-789" });
    expect(parseTin("")).toEqual({ ok: true, value: null });
    const lost = parseTin("4984946000", { numericCell: true });
    expect(lost.ok).toBe(false);
    expect(lost.ok ? "" : lost.error).toMatch(/format the column as Text/);
    expect(parseTin("12345").ok).toBe(false);
  });
});

describe("mapping the fixture end to end", () => {
  const sheet = readSheet(XLSX, null, { maxRows: 100, maxCols: 100, maxCellChars: 2000 });
  const rows: SheetRow[] = sheet.rows;

  it("finds the header row under title rows and suggests columns", () => {
    const h = detectHeaderRow(rows);
    expect(rows[h].rowNumber).toBe(4);
    expect(suggestMapping(rows[h].cells, "transactions")).toMatchObject({
      txn_date: 0,
      document_ref: 1,
      counterparty_name: 2,
      counterparty_tin: 3,
      description: 4,
      gross_amount: 5,
      vat_amount_stated: null,
    });
  });

  it("converts rows, with row-level errors pointing at the Excel row", () => {
    const h = detectHeaderRow(rows);
    const mapping = suggestMapping(rows[h].cells, "transactions");
    const results = applyMapping("transactions", rows.slice(h + 1), mapping, {
      dateFormat: "MDY",
      defaultKind: "purchase",
      today: "2026-10-10",
    });
    expect(results.map((r) => r.row_no)).toEqual([5, 6, 7, 9]);
    expect(results[0]).toEqual({
      row_no: 5,
      errors: [],
      normalized: {
        kind: "purchase",
        txn_date: "2026-09-03",
        document_ref: "OR-1001",
        counterparty_name: "Sample Fuels Corp.",
        counterparty_tin: "004-984-946-00000",
        description: "Diesel",
        gross_amount: "2240.00",
        vat_amount_stated: null,
        withholding_amount_stated: null,
        payment_method: null,
      },
    });
    expect(results[1].normalized?.gross_amount).toBe("64020.00");
    expect(results[1].normalized?.counterparty_tin).toBe("444-555-666-000");
    expect(results[2].normalized).toMatchObject({
      txn_date: "2026-09-08",
      counterparty_tin: "706-567-954-00001",
      gross_amount: "200.00",
    });
    // The TOTAL row is not a transaction.
    expect(results[3].normalized).toBeNull();
    expect(results[3].errors.map((e) => e.field)).toEqual([
      "txn_date",
      "counterparty_name",
      "document_ref",
    ]);
  });

  it("enforces the same required fields as the database", () => {
    const results = applyMapping(
      "transactions",
      [{ rowNumber: 2, cells: ["2026-09-01", "", "", "", "", "100"] }],
      {
        txn_date: 0,
        document_ref: 1,
        counterparty_name: 2,
        counterparty_tin: 3,
        description: 4,
        gross_amount: 5,
      },
      { dateFormat: "YMD", defaultKind: "sale", today: "2026-10-10" },
    );
    expect(results[0].errors.map((e) => e.message)).toEqual([
      "Customer/supplier is required",
      "Invoice/receipt number is required for sales and purchases",
    ]);
    const future = applyMapping(
      "transactions",
      [{ rowNumber: 2, cells: ["2026-12-01", "SI-1", "X", "", "", "100"] }],
      {
        txn_date: 0,
        document_ref: 1,
        counterparty_name: 2,
        counterparty_tin: 3,
        description: 4,
        gross_amount: 5,
      },
      { dateFormat: "YMD", defaultKind: "sale", today: "2026-10-10" },
    );
    expect(future[0].errors).toEqual([
      { field: "txn_date", message: "Date cannot be in the future" },
    ]);
  });

  it("maps a supplier list", () => {
    const s = readSheet(XLSX, "Suppliers", { maxRows: 10, maxCols: 10, maxCellChars: 100 });
    const mapping = suggestMapping(s.rows[0].cells, "counterparties");
    const [r] = applyMapping("counterparties", s.rows.slice(1), mapping, {
      dateFormat: "MDY",
      defaultKind: "supplier",
    });
    expect(r.normalized).toEqual({
      kind: "supplier",
      registered_name: "Sample Fuels Corp.",
      tin: "004-984-946-00000",
      vat_status: "vat_registered",
      address: null,
      email: null,
      phone: null,
    });
  });
});
