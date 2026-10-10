import { readFileSync } from "node:fs";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { checkFile, MAX_DOCUMENT_BYTES, MAX_IMPORT_BYTES, sanitizeFileName } from "./files";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);
const PDF = text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const XLSX = new Uint8Array(
  readFileSync(join(process.cwd(), "tests/fixtures/synthetic-books.xlsx")),
);

function office(files: Record<string, string | Uint8Array>) {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(entries);
}
const CT =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>';

describe("accepted files", () => {
  it.each([
    ["receipt.pdf", PDF, "application/pdf"],
    ["photo.PNG", PNG, "image/png"],
    ["scan.jpeg", JPG, "image/jpeg"],
    ["sales.csv", text("date,amount\n2026-09-01,100\n"), "text/csv"],
    ["books.xlsx", XLSX, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ])("%s", (name, data, mime) => {
    const r = checkFile(name, data);
    expect(r).toMatchObject({ ok: true, mimeType: mime });
  });

  it("a minimal valid .docx", () => {
    const docx = office({ "[Content_Types].xml": CT, "word/document.xml": "<w:document/>" });
    expect(checkFile("letter.docx", docx)).toMatchObject({ ok: true, extension: "docx" });
  });
});

describe("malicious or invalid files are refused", () => {
  const refuse = (name: string, data: Uint8Array, max?: number) => {
    const r = checkFile(name, data, max);
    expect(r.ok, name).toBe(false);
    return r.ok ? "" : r.reason;
  };

  it("executables, even when renamed", () => {
    const exe = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03);
    expect(refuse("setup.exe", exe)).toMatch(/not allowed/);
    expect(refuse("invoice.pdf", exe)).toMatch(/Programs, scripts and web pages/);
    expect(refuse("invoice.pdf.exe", PDF)).toMatch(/not allowed/);
    expect(refuse("photo.jpg", bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1))).toMatch(/Programs/);
    expect(refuse("notes.txt", text("#!/bin/sh\nrm -rf /\n"))).toMatch(/Programs/);
  });

  it("web content (HTML, SVG, scripts) disguised as allowed types", () => {
    expect(refuse("receipt.pdf", text("<!DOCTYPE html><script>alert(1)</script>"))).toMatch(
      /web pages/,
    );
    expect(
      refuse("logo.png", text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
    ).toMatch(/web pages/);
    expect(refuse("data.csv", text("<html><body>x</body></html>"))).toMatch(/web pages/);
    expect(refuse("page.html", text("<html></html>"))).toMatch(/not allowed/);
    expect(refuse("image.svg", text("<svg/>"))).toMatch(/not allowed/);
  });

  it("content that does not match the extension", () => {
    expect(refuse("receipt.pdf", PNG)).toMatch(/does not match/);
    expect(refuse("photo.png", PDF)).toMatch(/does not match/);
    expect(refuse("data.csv", bytes(0x00, 0x01, 0x02, 0x03))).toMatch(/does not match/);
    expect(refuse("data.csv", XLSX)).toMatch(/does not match/);
    expect(refuse("books.xlsx", PDF)).toMatch(/does not match/);
    expect(refuse("letter.docx", XLSX)).toMatch(/does not match/);
  });

  it("macro-enabled or object-embedding Office files", () => {
    const macro = office({
      "[Content_Types].xml": CT,
      "xl/workbook.xml": "<workbook/>",
      "xl/vbaProject.bin": bytes(1, 2, 3),
    });
    expect(refuse("books.xlsx", macro)).toMatch(/macros/);
    const macroType = office({
      "[Content_Types].xml": CT.replace(
        "</Types>",
        '<Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
      ),
      "xl/workbook.xml": "<workbook/>",
    });
    expect(refuse("books.xlsx", macroType)).toMatch(/macros/);
    const embedded = office({
      "[Content_Types].xml": CT,
      "xl/workbook.xml": "<workbook/>",
      "xl/embeddings/oleObject1.bin": bytes(1),
    });
    expect(refuse("books.xlsx", embedded)).toMatch(/embedded/);
    expect(refuse("books.xlsm", macro)).toMatch(/not allowed/);
  });

  it("zip bombs and damaged archives", () => {
    const bomb = zipSync(
      { "[Content_Types].xml": strToU8(CT), "xl/workbook.xml": new Uint8Array(20 * 1024 * 1024) },
      { level: 9 },
    );
    expect(bomb.length).toBeLessThan(200_000);
    expect(refuse("books.xlsx", bomb)).toMatch(/unsafe size/);
    expect(refuse("books.xlsx", bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0))).toMatch(
      /damaged|not a valid/,
    );
    const plainZip = office({ "readme.txt": "hello" });
    expect(refuse("books.xlsx", plainZip)).toMatch(/not a valid Office|does not match/);
  });

  it("empty and oversize files", () => {
    expect(refuse("receipt.pdf", new Uint8Array(0))).toMatch(/empty/);
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(PDF);
    expect(refuse("receipt.pdf", big)).toMatch(/larger than 10 MB/);
    const csv = new Uint8Array(MAX_IMPORT_BYTES + 1).fill(0x61);
    expect(refuse("data.csv", csv, MAX_IMPORT_BYTES)).toMatch(/larger than 5 MB/);
  });

  it("files without a usable name or extension", () => {
    expect(refuse("noextension", PDF)).toMatch(/not allowed/);
    expect(refuse(".pdf", PDF)).toMatch(/not allowed/);
  });
});

describe("file names", () => {
  it("strips paths, control and bidirectional-override characters", () => {
    expect(sanitizeFileName("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFileName("C:\\Users\\x\\receipt.pdf")).toBe("receipt.pdf");
    expect(sanitizeFileName("inv\u0000oice.pdf")).toBe("invoice.pdf");
    // "photo\u202Egpj.exe" displays as "photoexe.jpg" but is an .exe
    expect(sanitizeFileName("photo\u202Egpj.exe")).toBe("photogpj.exe");
    expect(checkFile("photo\u202Egpj.exe", JPG).ok).toBe(false);
  });

  it("keeps the extension when shortening long names", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const s = sanitizeFileName(long);
    expect(s.length).toBe(255);
    expect(s.endsWith(".pdf")).toBe(true);
  });
});
