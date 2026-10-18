import { NextResponse, type NextRequest } from "next/server";

import { toPublicError } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/server";
import { resolveRequestId } from "@/lib/logging/request-id";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentAccess } from "@/server/auth/access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Downloads the exact generated file (bytes as stored, the file name from the
 * specification's rule), for running the official validation tool. Assigned
 * staff only (RLS). The response says nothing about validity: the run page does.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/outputs/[runId]">) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const notFound = () =>
    NextResponse.json(
      { code: "NOT_FOUND", message: "Not found." },
      { status: 404, headers: NO_STORE },
    );
  try {
    const { runId } = await ctx.params;
    if (!UUID.test(runId)) return notFound();
    const access = await getCurrentAccess();
    if (!access) {
      return NextResponse.json(
        { code: "UNAUTHENTICATED", message: "Please sign in." },
        { status: 401, headers: NO_STORE },
      );
    }
    const sb = await createSupabaseServerClient();
    const { data } = await sb
      .from("output_runs")
      .select("client_id, filename, content")
      .eq("id", runId.toLowerCase())
      .maybeSingle();
    if (
      !data ||
      data.content === null ||
      !access.staff_client_ids.includes(data.client_id as string)
    ) {
      return notFound();
    }
    const name = String(data.filename || "output.txt").replace(/[^A-Za-z0-9._-]/g, "_");
    return new NextResponse(new TextEncoder().encode(data.content as string), {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  } catch (error) {
    getLogger().error("output download failed", { requestId, error });
    return NextResponse.json(toPublicError(error, requestId), { status: 500, headers: NO_STORE });
  }
}
