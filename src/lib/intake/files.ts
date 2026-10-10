import { unzipSync } from "fflate";

/**
 * Upload safety checks. Pure functions (no I/O), used by the server BEFORE any
 * byte reaches storage. The declared extension must match what the bytes
 * actually are; anything not on the allowlist is refused.
 *
 * This is not malware scanning (open item R-12): it blocks executables, web
 * content, macro-enabled Office files and zip bombs, and makes sure a file is
 * what it claims to be.
 */

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export const ALLOWED_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  csv: "text/csv",
  txt: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export type AllowedExtension = keyof typeof ALLOWED_TYPES;

/** Accept attribute for file inputs. */
export const DOCUMENT_ACCEPT = Object.keys(ALLOWED_TYPES)
  .map((e) => `.${e}`)
  .join(",");
export const IMPORT_ACCEPT = ".csv,.xlsx";

export type FileCheck =
  | { ok: true; extension: AllowedExtension; mimeType: string; safeName: string }
  | { ok: false; reason: string };

const ZIP_LIMITS = { maxEntries: 5000, maxTotalUncompressed: 100 * 1024 * 1024, maxRatio: 200 };

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

/** Removes path parts, control characters and bidirectional overrides (e.g. "‮fdp.exe"). */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").trim();
  if (cleaned.length <= 255) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 255 - ext.length) + ext;
}

/** Recognizes common dangerous content, for a clearer refusal message. */
function looksDangerous(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x4d, 0x5a])) return true; // MZ: Windows executable
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  if (startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]))
    return true; // Mach-O
  if (startsWith(bytes, [0x23, 0x21])) return true; // "#!" script
  const head = ascii(bytes, 0, 512).replace(/^﻿/, "").trimStart().toLowerCase();
  return /^<(!doctype html|html|svg|script|\?xml[^>]*>\s*<svg)/.test(head);
}

function isProbablyText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 65536));
  for (const b of sample) {
    if (b === 0) return false;
  }
  return true;
}

type ZipEntry = { name: string; size: number; originalSize: number };

function inspectZip(
  bytes: Uint8Array,
): { entries: ZipEntry[]; contentTypes: string | null } | null {
  const entries: ZipEntry[] = [];
  let contentTypes: string | null = null;
  try {
    const out = unzipSync(bytes, {
      filter(file) {
        entries.push({ name: file.name, size: file.size, originalSize: file.originalSize });
        // Only the (small) content-types manifest is ever decompressed here.
        return file.name === "[Content_Types].xml" && file.originalSize < 1024 * 1024;
      },
    });
    const ct = out["[Content_Types].xml"];
    if (ct) contentTypes = new TextDecoder().decode(ct);
  } catch {
    return null;
  }
  return { entries, contentTypes };
}

function checkOfficeZip(bytes: Uint8Array, kind: "xlsx" | "docx"): string | null {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]))
    return "The file content does not match its extension.";
  const zip = inspectZip(bytes);
  if (!zip) return "The file is damaged or not a valid Office document.";
  const { entries, contentTypes } = zip;
  if (entries.length > ZIP_LIMITS.maxEntries) return "The file contains too many parts.";
  const total = entries.reduce((s, e) => s + e.originalSize, 0);
  if (total > ZIP_LIMITS.maxTotalUncompressed) return "The file expands to an unsafe size.";
  if (
    entries.some(
      (e) =>
        e.originalSize > 1024 * 1024 && e.originalSize / Math.max(e.size, 1) > ZIP_LIMITS.maxRatio,
    )
  ) {
    return "The file expands to an unsafe size.";
  }
  const names = entries.map((e) => e.name.toLowerCase());
  if (!names.includes("[content_types].xml") || !contentTypes)
    return "The file is not a valid Office document.";
  const main = kind === "xlsx" ? "xl/workbook.xml" : "word/document.xml";
  if (!names.includes(main)) return "The file content does not match its extension.";
  if (
    names.some(
      (n) => n.endsWith("vbaproject.bin") || n.includes("activex") || n.includes("/embeddings/"),
    ) ||
    /macroEnabled|vbaProject|activeX/i.test(contentTypes)
  ) {
    return "Files with macros or embedded objects are not allowed. Save it as a normal .xlsx or .docx.";
  }
  return null;
}

/** Verifies an upload's size, name and actual content. */
export function checkFile(
  name: string,
  bytes: Uint8Array,
  maxBytes = MAX_DOCUMENT_BYTES,
): FileCheck {
  const safeName = sanitizeFileName(name);
  if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    };
  }
  const dot = safeName.lastIndexOf(".");
  const ext = dot > 0 ? safeName.slice(dot + 1).toLowerCase() : "";
  if (!safeName || !(ext in ALLOWED_TYPES)) {
    return {
      ok: false,
      reason: `This file type is not allowed. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}.`,
    };
  }
  const extension = ext as AllowedExtension;
  if (looksDangerous(bytes)) {
    return { ok: false, reason: "Programs, scripts and web pages cannot be uploaded." };
  }

  let problem: string | null = null;
  switch (extension) {
    case "pdf":
      problem = ascii(bytes, 0, 1024).includes("%PDF-") ? null : "mismatch";
      break;
    case "png":
      problem = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? null
        : "mismatch";
      break;
    case "jpg":
    case "jpeg":
      problem = startsWith(bytes, [0xff, 0xd8, 0xff]) ? null : "mismatch";
      break;
    case "webp":
      problem = ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP" ? null : "mismatch";
      break;
    case "heic":
      problem =
        ascii(bytes, 4, 8) === "ftyp" &&
        /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(ascii(bytes, 8, 12))
          ? null
          : "mismatch";
      break;
    case "csv":
    case "txt":
      problem =
        isProbablyText(bytes) &&
        !startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
        !ascii(bytes, 0, 8).startsWith("%PDF")
          ? null
          : "mismatch";
      break;
    case "xlsx":
    case "docx":
      problem = checkOfficeZip(bytes, extension);
      break;
  }
  if (problem === "mismatch") {
    return { ok: false, reason: "The file content does not match its extension." };
  }
  if (problem) return { ok: false, reason: problem };
  return { ok: true, extension, mimeType: ALLOWED_TYPES[extension], safeName };
}
