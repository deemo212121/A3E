"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { BUTTON_VARIANTS } from "@/components/ui/primitives";
import { uploadDocumentAction } from "@/features/intake/document-actions";
import { DOCUMENT_ACCEPT, MAX_DOCUMENT_BYTES } from "@/lib/intake/files";
import { DOCUMENT_CATEGORIES } from "@/lib/intake/rules";

type ItemState = "queued" | "uploading" | "done" | "error";
interface Item {
  key: string;
  file: File;
  state: ItemState;
  message?: string;
}

const CATEGORY_OPTIONS = DOCUMENT_CATEGORIES.filter((c) => c.value !== "import_source");
const MB = 1024 * 1024;

/**
 * Uploads files ONE PER REQUEST (each under the 10 MB limit), sequentially,
 * with per-file status. Each file gets its own idempotency key when chosen,
 * so pressing "Upload" again after a failure retries without duplicates.
 * The server re-checks every file's actual content.
 */
export function DocumentUploader({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("expense_receipt");
  const [period, setPeriod] = useState("");
  const [description, setDescription] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const setItem = (key: string, patch: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  async function uploadAll() {
    setBusy(true);
    for (const item of items) {
      if (item.state === "done") continue;
      if (item.file.size > MAX_DOCUMENT_BYTES) {
        setItem(item.key, { state: "error", message: "Larger than 10 MB." });
        continue;
      }
      setItem(item.key, { state: "uploading", message: undefined });
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("idempotencyKey", item.key);
      fd.set("category", category);
      fd.set("periodMonth", period);
      fd.set("description", description);
      fd.set("file", item.file);
      try {
        const result = await uploadDocumentAction(null, fd);
        setItem(
          item.key,
          result.ok ? { state: "done" } : { state: "error", message: result.error.message },
        );
      } catch {
        setItem(item.key, { state: "error", message: "Network error. Press Upload to retry." });
      }
    }
    setBusy(false);
    router.refresh();
  }

  const pending = items.filter((i) => i.state !== "done").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>What are these?</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Month they belong to (optional)</span>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Note (optional)</span>
          <input
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span>Files (PDF, photos, Excel, Word, CSV; up to 10 MB each)</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={DOCUMENT_ACCEPT}
          disabled={busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            setItems((list) => [
              ...list.filter((i) => i.state !== "done"),
              ...files.map((file) => ({
                key: `upload-${crypto.randomUUID()}`,
                file,
                state: "queued" as const,
              })),
            ]);
            if (inputRef.current) inputRef.current.value = "";
          }}
          className="rounded-md border border-dashed border-[var(--border)] bg-[var(--surface)] p-3"
        />
      </label>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm" aria-live="polite">
          {items.map((i) => (
            <li
              key={i.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-2"
            >
              <span className="break-all">
                {i.file.name}{" "}
                <span className="text-xs text-[var(--muted)]">
                  ({(i.file.size / MB).toFixed(2)} MB)
                </span>
              </span>
              <span
                className={
                  i.state === "done"
                    ? "text-[var(--success)]"
                    : i.state === "error"
                      ? "text-[var(--danger)]"
                      : "text-[var(--muted)]"
                }
              >
                {i.state === "done"
                  ? "✓ Uploaded"
                  : i.state === "uploading"
                    ? "Uploading…"
                    : i.state === "error"
                      ? i.message
                      : "Ready"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || pending === 0}
          onClick={uploadAll}
          className={BUTTON_VARIANTS.primary}
        >
          {busy
            ? "Uploading…"
            : pending > 0
              ? `Upload ${pending} file${pending === 1 ? "" : "s"}`
              : "Upload"}
        </button>
        {items.some((i) => i.state === "done") && !busy ? (
          <button
            type="button"
            onClick={() => setItems((l) => l.filter((i) => i.state !== "done"))}
            className={BUTTON_VARIANTS.secondary}
          >
            Clear finished
          </button>
        ) : null}
      </div>
      <p className="text-xs text-[var(--muted)]">
        Files are stored privately for this business only. The same file cannot be uploaded twice.
        Programs, web pages and files with macros are refused.
      </p>
    </div>
  );
}
