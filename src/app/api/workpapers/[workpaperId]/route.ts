import { NextResponse, type NextRequest } from "next/server";

import { toPublicError } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/server";
import { resolveRequestId } from "@/lib/logging/request-id";
import { toCsv } from "@/lib/reports/csv";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentAccess } from "@/server/auth/access";
import { getWorkpaper } from "@/server/data/forms";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * CSV export of a tax workpaper (lines, sources, messages, schedules). A
 * working paper for preparing the return by hand: NOT a filing file and not
 * sent anywhere. Read under the caller's session (assigned staff only).
 */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workpapers/[workpaperId]">,
) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const notFound = () =>
    NextResponse.json(
      { code: "NOT_FOUND", message: "Not found." },
      { status: 404, headers: NO_STORE },
    );
  try {
    const { workpaperId } = await ctx.params;
    if (!UUID.test(workpaperId)) return notFound();
    const access = await getCurrentAccess();
    if (!access)
      return NextResponse.json(
        { code: "UNAUTHENTICATED", message: "Please sign in." },
        { status: 401, headers: NO_STORE },
      );
    const sb = await createSupabaseServerClient();
    const { data: row } = await sb
      .from("tax_workpapers")
      .select("client_id")
      .eq("id", workpaperId.toLowerCase())
      .maybeSingle();
    if (!row || !access.staff_client_ids.includes(row.client_id as string)) return notFound();
    const w = await getWorkpaper(row.client_id as string, workpaperId.toLowerCase());
    if (!w || !w.form) return notFound();
    const rows: (string | null)[][] = [
      [`${w.form_code} v${w.form.version}`, `official version ${w.form.official_version}`],
      [`Period ${w.period_from} to ${w.period_to}`, `Status ${w.status}`],
      ["WORKPAPER ONLY - not a filed return; prepare the official form separately"],
      [],
      ["Line", "Label", "Value", "Source"],
      ...w.form.definition.lines.map((l) => [
        l.code,
        l.label,
        w.lines[l.code] ?? "",
        JSON.stringify(w.line_sources[l.code] ?? {}),
      ]),
      [],
      ["Messages"],
      ...w.messages.map((m) => [m.severity, m.code, m.message]),
      [],
      ["Schedule", "Date", "Entry no", "Source", "Amount"],
      ...w.schedule.map((s) => [
        s.schedule_title,
        s.entry_date,
        String(s.entry_no),
        s.source_type ?? "manual",
        s.amount,
      ]),
      [],
      ["Limitations", w.form.limitations],
    ];
    const name = `${w.form_code}-${w.period_from}-${w.period_to}.csv`.replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    return new NextResponse(toCsv(rows), {
      headers: {
        ...NO_STORE,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  } catch (error) {
    getLogger().error("workpaper export failed", { requestId, error });
    return NextResponse.json(toPublicError(error, requestId), { status: 500, headers: NO_STORE });
  }
}
