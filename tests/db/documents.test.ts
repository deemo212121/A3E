/**
 * Phase 6 document vault tests (PGlite with a Storage stub). Synthetic data.
 *
 * Upload = (1) begin_document_upload as the user (authority + pending row),
 * (2) the server writes the bytes with the server-only key (emulated here by a
 * superuser insert into storage.objects), (3) complete_document_upload as the
 * user. API users have NO insert policy on storage.objects.
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  actor,
  asUser,
  createTestDb,
  IDS,
  pgErrorCode,
  seedFixture,
  type Db,
  type UserKey,
} from "./harness";
import { intake, newKey, purchase } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const B: string = IDS.clientB;
const PDF = "application/pdf";

const BEGIN =
  "select * from public.begin_document_upload($1, $2, $3, $4, $5, $6, $7, $8::public.document_category, $9::date, $10)";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function begin(
  who: UserKey,
  opts: {
    client?: string;
    key?: string;
    name?: string;
    ext?: string;
    mime?: string;
    size?: number;
    hash?: string;
    category?: string;
  } = {},
) {
  const rows = await h.run<{ document_id: string; object_path: string; state: string }>(
    who,
    BEGIN,
    [
      opts.client ?? A,
      opts.key ?? newKey("doc"),
      opts.name ?? "receipt.pdf",
      opts.ext ?? "pdf",
      opts.mime ?? PDF,
      opts.size ?? 1234,
      opts.hash ?? sha(newKey("bytes")),
      opts.category ?? "expense_receipt",
      null,
      null,
    ],
  );
  return rows[0];
}

const beginError = (who: UserKey, opts: Parameters<typeof begin>[1] = {}) =>
  h.errorOf(who, BEGIN, [
    opts.client ?? A,
    opts.key ?? newKey("doc"),
    opts.name ?? "receipt.pdf",
    opts.ext ?? "pdf",
    opts.mime ?? PDF,
    opts.size ?? 1234,
    opts.hash ?? sha(newKey("bytes")),
    opts.category ?? "expense_receipt",
    null,
    null,
  ]);

/** What the server does with the server-only key after begin. */
const storeBytes = (path: string, size: number) =>
  db.query(
    "insert into storage.objects (bucket_id, name, metadata) values ('client-documents', $1, jsonb_build_object('size', $2::bigint))",
    [path, size],
  );

const complete = (who: UserKey, id: string) =>
  h.run(who, "select public.complete_document_upload($1)", [id]);

async function uploaded(who: UserKey, opts: Parameters<typeof begin>[1] = {}) {
  const d = await begin(who, opts);
  await storeBytes(d.object_path, opts.size ?? 1234);
  await complete(who, d.document_id);
  return d;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
}, 60_000);

describe("upload authority and validation", () => {
  it("client owner/staff and assigned staff may upload; viewers, other tenants and admins may not", async () => {
    for (const who of ["ownerA", "staffA", "reviewerA", "manager"] as const) {
      expect(await beginError(who), who).toBeUndefined();
    }
    for (const who of ["viewerA", "ownerB", "outsider", "firmAdmin"] as const) {
      expect(await beginError(who), who).toBe("42501");
    }
  });

  it("the storage path is fixed by the database, inside the client's folder", async () => {
    const d = await begin("ownerA", { name: "../../etc/passwd.pdf" });
    expect(d.object_path).toMatch(
      new RegExp(`^clients/${A}/\\d{4}/\\d{2}/${d.document_id}\\.pdf$`),
    );
  });

  it("rejects disallowed or mismatched types and oversize files", async () => {
    expect(await beginError("ownerA", { ext: "exe", mime: "application/x-msdownload" })).toBe(
      "22023",
    );
    expect(await beginError("ownerA", { ext: "html", mime: "text/html" })).toBe("22023");
    expect(await beginError("ownerA", { ext: "svg", mime: "image/svg+xml" })).toBe("22023");
    expect(await beginError("ownerA", { ext: "pdf", mime: "image/png" })).toBe("22023");
    expect(
      await beginError("ownerA", {
        ext: "xlsm",
        mime: "application/vnd.ms-excel.sheet.macroEnabled.12",
      }),
    ).toBe("22023");
    expect(await beginError("ownerA", { size: 10 * 1024 * 1024 + 1 })).toBe("23514");
    expect(await beginError("ownerA", { size: 0 })).toBe("23514");
    expect(await beginError("ownerA", { hash: "not-a-hash" })).toBe("23514");
  });
});

describe("GATE: retries record one document", () => {
  it("replaying begin with the same key returns the same pending document", async () => {
    const key = newKey("retry");
    const a = await begin("ownerA", { key });
    const b = await begin("ownerA", { key });
    expect(b.document_id).toBe(a.document_id);
    expect(b.object_path).toBe(a.object_path);
  });

  it("completing twice is a no-op", async () => {
    const d = await begin("ownerA");
    await storeBytes(d.object_path, 1234);
    await complete("ownerA", d.document_id);
    await complete("ownerA", d.document_id);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.intake_events where subject_id = $1 and to_status = 'uploaded'",
      [d.document_id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("the same file (same SHA-256) cannot be stored twice for a client", async () => {
    const hash = sha("identical bytes");
    await uploaded("ownerA", { hash });
    expect(await beginError("staffA", { hash })).toBe("23505");
    // Another client may upload the same bytes.
    expect(await beginError("ownerB", { client: B, hash })).toBeUndefined();
  });

  it("two in-flight uploads of the same file: only the first to complete wins", async () => {
    const hash = sha("racing bytes");
    const a = await begin("ownerA", { hash });
    const b = await begin("staffA", { hash });
    await storeBytes(a.object_path, 1234);
    await storeBytes(b.object_path, 1234);
    await complete("ownerA", a.document_id);
    expect(
      await h.errorOf("staffA", "select public.complete_document_upload($1)", [b.document_id]),
    ).toBe("23505");
  });
});

describe("storage object policies", () => {
  it("API users cannot write objects directly, not even to their own client's folder", async () => {
    const d = await begin("ownerA");
    expect(
      await h.errorOf(
        "ownerA",
        "insert into storage.objects (bucket_id, name, metadata) values ('client-documents', $1, '{\"size\":1}')",
        [d.object_path],
      ),
    ).toBe("42501");
    expect(await h.errorOf("ownerA", "update storage.objects set name = 'x'")).toBeUndefined(); // 0 rows visible
    const changed = await db.query("select 1 from storage.objects where name = 'x'");
    expect(changed.rows).toEqual([]);
  });

  it("completion fails until the bytes are actually stored with the declared size", async () => {
    const d = await begin("ownerA", { size: 500 });
    expect(
      await h.errorOf("ownerA", "select public.complete_document_upload($1)", [d.document_id]),
    ).toBe("22023");
    await storeBytes(d.object_path, 499);
    expect(
      await h.errorOf("ownerA", "select public.complete_document_upload($1)", [d.document_id]),
    ).toBe("22023");
  });

  it("only the uploader can complete their upload", async () => {
    const d = await begin("ownerA");
    await storeBytes(d.object_path, 1234);
    expect(
      await h.errorOf("staffA", "select public.complete_document_upload($1)", [d.document_id]),
    ).toBe("P0002");
  });

  it("objects are readable by users of the same client only", async () => {
    const d = await uploaded("ownerA");
    const visible = (who: UserKey) =>
      asUser(
        db,
        actor(who),
        async (tx) =>
          (await tx.query("select name from storage.objects where name = $1", [d.object_path])).rows
            .length,
      );
    for (const who of ["ownerA", "staffA", "viewerA", "reviewerA", "manager"] as const) {
      expect(await visible(who), who).toBe(1);
    }
    for (const who of ["ownerB", "outsider", "firmAdmin"] as const) {
      expect(await visible(who), who).toBe(0);
    }
  });

  it("a pending upload is visible only to its uploader and staff", async () => {
    const d = await begin("ownerA");
    const sees = (who: UserKey) =>
      asUser(
        db,
        actor(who),
        async (tx) =>
          (await tx.query("select 1 from public.documents where id = $1", [d.document_id])).rows
            .length,
      );
    expect(await sees("ownerA")).toBe(1);
    expect(await sees("reviewerA")).toBe(1);
    expect(await sees("staffA")).toBe(0);
    expect(await sees("viewerA")).toBe(0);
  });
});

describe("review, soft delete, access logging", () => {
  it("only assigned staff review; corrections need a comment", async () => {
    const d = await uploaded("ownerA");
    const REVIEW = "select public.set_document_review($1, $2::public.document_review, $3)";
    expect(await h.errorOf("ownerA", REVIEW, [d.document_id, "accepted", null])).toBe("42501");
    expect(await h.errorOf("reviewerA", REVIEW, [d.document_id, "needs_correction", null])).toBe(
      "22023",
    );
    await h.run("reviewerA", REVIEW, [d.document_id, "needs_correction", "Blurry; please rescan"]);
    const ev = await db.query<{ to_status: string; comment: string }>(
      "select to_status, comment from public.intake_events where subject_id = $1 order by id desc limit 1",
      [d.document_id],
    );
    expect(ev.rows[0]).toEqual({ to_status: "needs_correction", comment: "Blurry; please rescan" });
  });

  it("soft delete: own unreviewed upload or a reviewer; never while attached; never a hard delete", async () => {
    const DEL = "select public.delete_document($1, $2)";
    const own = await uploaded("staffA");
    expect(await h.errorOf("ownerA", DEL, [own.document_id, "wrong file"])).toBe("42501"); // not the uploader
    expect(await h.errorOf("staffA", DEL, [own.document_id, ""])).toBe("22023"); // reason required
    await h.run("staffA", DEL, [own.document_id, "wrong file"]);
    const gone = await h.read("ownerA", "select 1 from public.documents where id = $1", [
      own.document_id,
    ]);
    expect(gone).toEqual([]); // hidden from client users once deleted
    const kept = await db.query("select deleted_at from public.documents where id = $1", [
      own.document_id,
    ]);
    expect(kept.rows).toHaveLength(1); // but the record remains

    const attached = await uploaded("ownerA");
    await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-ATT" }), {
      docs: [attached.document_id],
    });
    expect(await h.errorOf("reviewerA", DEL, [attached.document_id, "duplicate"])).toBe("22023");
    let code: string | undefined;
    try {
      await db.query("delete from public.documents where id = $1", [attached.document_id]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  it("downloads are logged; other tenants cannot even log access", async () => {
    const d = await uploaded("ownerA");
    await h.run("viewerA", "select public.log_document_access($1)", [d.document_id]);
    const log = await db.query<{ n: number }>(
      "select count(*)::int as n from audit.events where action = 'document.downloaded' and details ->> 'document_id' = $1",
      [d.document_id],
    );
    expect(log.rows[0].n).toBe(1);
    expect(
      await h.errorOf("ownerB", "select public.log_document_access($1)", [d.document_id]),
    ).toBe("P0002");
  });

  it("transactions can attach only this client's completed documents", async () => {
    const pending = await begin("ownerA");
    expect(
      await pgErrorCode(
        h.saveTxn("ownerA", A, purchase({ document_ref: "OR-PEND" }), {
          docs: [pending.document_id],
        }),
      ),
    ).toBe("22023");
    const other = await uploaded("ownerB", { client: B });
    expect(
      await pgErrorCode(
        h.saveTxn("ownerA", A, purchase({ document_ref: "OR-OTHER" }), {
          docs: [other.document_id],
        }),
      ),
    ).toBe("22023");
  });
});
