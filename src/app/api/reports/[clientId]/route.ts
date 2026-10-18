import { NextResponse, type NextRequest } from "next/server";

import { toPublicError } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/server";
import { resolveRequestId } from "@/lib/logging/request-id";
import { toCsv } from "@/lib/reports/csv";
import { toText } from "@/lib/reports/statements";
import { todayManila } from "@/lib/dates";
import { getCurrentAccess } from "@/server/auth/access";
import { getVisibleClient } from "@/server/data/workspace";
import {
  buildReport,
  parseOptions,
  PORTAL_REPORTS,
  REPORTS,
  type ReportKey,
} from "@/server/reports/build";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * CSV export of a report. Staff assigned to the client get every report;
 * client users only the statements, and the database refuses periods that are
 * not closed yet. All data is read under the caller's own session (RLS).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/reports/[clientId]">) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const json = (status: number, code: string, message: string) =>
    NextResponse.json({ code, message }, { status, headers: NO_STORE });
  try {
    const { clientId: raw } = await ctx.params;
    if (!UUID.test(raw)) return json(404, "NOT_FOUND", "Not found.");
    const clientId = raw.toLowerCase();
    const access = await getCurrentAccess();
    if (!access) return json(401, "UNAUTHENTICATED", "Please sign in.");
    if (!access.is_active || access.mfa_required) return json(403, "FORBIDDEN", "Not allowed.");
    const staff = access.staff_client_ids.includes(clientId);
    const member = access.client_memberships.some((m) => m.client_id === clientId);
    if (!staff && !member) return json(404, "NOT_FOUND", "Not found.");
    const client = await getVisibleClient(clientId);
    if (!client) return json(404, "NOT_FOUND", "Not found.");

    const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
    const allowed: ReportKey[] = staff ? (Object.keys(REPORTS) as ReportKey[]) : PORTAL_REPORTS;
    const options = parseOptions(sp, todayManila(), allowed);
    const report = await buildReport(clientId, options);

    const rows: (string | null)[][] = [
      [client.display_name],
      [report.title, report.subtitle],
      [
        report.openPeriods > 0
          ? "PRELIMINARY: some periods are still open"
          : "All periods in range are closed",
      ],
      [options.rounding === "peso" ? "Amounts in whole pesos" : "Amounts in pesos and centavos"],
      [],
      ["Line", ...report.table.columns],
      ...report.table.rows.map((r) => [
        r.kind === "line" ? `  ${r.label}` : r.label,
        ...(r.kind === "heading" ? [] : r.values.map((v) => (v === null ? "" : toText(v)))),
      ]),
      [],
      ...report.checks.map((c) => [`${c.ok ? "OK" : "FAILED"}: ${c.label}`]),
      ...report.notes.map((n) => [n]),
    ];
    const name = `${client.code}-${options.report}-${options.to}.csv`.replace(
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
    const pub = toPublicError(error, requestId);
    if (pub.code === "FORBIDDEN" || pub.code === "VALIDATION")
      return json(pub.code === "FORBIDDEN" ? 403 : 400, pub.code, pub.message);
    getLogger().error("report export failed", { requestId, error });
    return NextResponse.json(pub, { status: 500, headers: NO_STORE });
  }
}
