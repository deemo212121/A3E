import { connection, NextResponse } from "next/server";

import { toPublicError } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/server";
import { resolveRequestId } from "@/lib/logging/request-id";
import { getHealthReport } from "@/server/system/health";

export async function GET(request: Request) {
  await connection(); // always evaluate at request time
  const requestId = resolveRequestId(request.headers.get("x-request-id"));

  try {
    const report = getHealthReport();
    return NextResponse.json(report, {
      status: report.status === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    getLogger().error("health check failed", { requestId, error });
    return NextResponse.json(toPublicError(error, requestId), {
      status: 500,
      headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
  }
}
