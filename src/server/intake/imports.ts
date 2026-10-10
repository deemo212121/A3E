import "server-only";

import { AppError } from "@/lib/errors/app-error";
import { decodeText, parseCsv, SheetReadError } from "@/lib/intake/csv";
import { detectHeaderRow, type SheetRow } from "@/lib/intake/mapping";
import { readSheet, readWorkbook } from "@/lib/intake/xlsx";

export const IMPORT_LIMITS = { maxRows: 5000, maxCols: 100, maxCellChars: 2000 } as const;

export interface ParsedImport {
  fileType: "csv" | "xlsx";
  sheetNames: string[];
  sheetName: string | null;
  date1904: boolean;
  /** 1-based row number (as in the spreadsheet) of the header row. */
  headerRow: number;
  headers: string[];
  /** Data rows. Number cells are stored as JSON numbers so date serials and
   *  numeric TINs stay recognizable when the columns are mapped. */
  rows: (string | number)[][];
  rowNumbers: number[];
}

/**
 * Reads an import file that already passed checkFile(). The header row is the
 * one requested, or detected (title rows above the header are common).
 */
export function parseImportFile(
  bytes: Uint8Array,
  extension: string,
  opts: { sheetName?: string | null; headerRow?: number | null } = {},
): ParsedImport {
  try {
    let sheetRows: SheetRow[];
    let sheetNames: string[] = [];
    let sheetName: string | null = null;
    let date1904 = false;
    let fileType: "csv" | "xlsx";
    if (extension === "csv" || extension === "txt") {
      fileType = "csv";
      const grid = parseCsv(decodeText(bytes), {
        maxRows: IMPORT_LIMITS.maxRows + 50,
        maxCols: IMPORT_LIMITS.maxCols,
      });
      sheetRows = grid
        .map((cells, i) => ({ rowNumber: i + 1, cells }))
        .filter((r) => r.cells.some((c) => c.trim() !== ""));
    } else if (extension === "xlsx") {
      fileType = "xlsx";
      sheetNames = readWorkbook(bytes).sheetNames;
      const sheet = readSheet(bytes, opts.sheetName || null, {
        maxRows: IMPORT_LIMITS.maxRows + 50,
        maxCols: IMPORT_LIMITS.maxCols,
        maxCellChars: IMPORT_LIMITS.maxCellChars,
      });
      sheetName = sheet.name;
      date1904 = sheet.date1904;
      sheetRows = sheet.rows;
    } else {
      throw new SheetReadError("Import files must be .csv or .xlsx.");
    }
    if (sheetRows.length === 0) throw new SheetReadError("The file has no data.");

    let headerIndex: number;
    if (opts.headerRow) {
      headerIndex = sheetRows.findIndex((r) => r.rowNumber === opts.headerRow);
      if (headerIndex === -1)
        throw new SheetReadError(`Row ${opts.headerRow} is empty or does not exist.`);
    } else {
      headerIndex = detectHeaderRow(sheetRows);
    }
    const header = sheetRows[headerIndex];
    const width = Math.max(
      header.cells.length,
      ...sheetRows.slice(headerIndex + 1).map((r) => r.cells.length),
    );
    const headers = Array.from(
      { length: width },
      (_, i) => header.cells[i]?.trim() || `Column ${i + 1}`,
    );
    const data = sheetRows.slice(headerIndex + 1);
    if (data.length === 0) throw new SheetReadError("There are no rows below the header row.");
    if (data.length > IMPORT_LIMITS.maxRows) {
      throw new SheetReadError(
        `The file has ${data.length} rows; import at most ${IMPORT_LIMITS.maxRows} at a time.`,
      );
    }
    return {
      fileType,
      sheetNames,
      sheetName,
      date1904,
      headerRow: header.rowNumber,
      headers,
      rows: data.map((r) =>
        Array.from({ length: width }, (_, i) => {
          const v = r.cells[i] ?? "";
          const n = Number(v);
          return r.numeric?.[i] && v !== "" && Number.isFinite(n) ? n : v;
        }),
      ),
      rowNumbers: data.map((r) => r.rowNumber),
    };
  } catch (error) {
    if (error instanceof SheetReadError) {
      throw new AppError("VALIDATION", `import parse failed: ${error.message}`, {
        publicMessage: error.message,
        fieldErrors: { file: [error.message] },
      });
    }
    throw error;
  }
}

/** Converts stored raw cells back to the form the mapper expects. */
export function toSheetRows(rows: { row_no: number; raw: (string | number)[] }[]): SheetRow[] {
  return rows.map((r) => ({
    rowNumber: r.row_no,
    cells: r.raw.map((c) => (typeof c === "number" ? String(c) : c)),
    numeric: r.raw.map((c) => typeof c === "number"),
  }));
}
