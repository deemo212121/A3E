import { NextResponse, type NextRequest } from "next/server";

import { toPublicError } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/server";
import { resolveRequestId } from "@/lib/logging/request-id";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getDocumentForDownload } from "@/server/data/intake";
import { DOCUMENTS_BUCKET } from "@/server/intake/documents";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Document download (doc 07 §5): the signed-in user must be able to read the
 * document under RLS; the access is written to the audit log; the response
 * redirects to a signed URL valid for 60 seconds that forces a download
 * (never rendered inline), created with the USER's session so the storage
 * policy is checked again.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/documents/[documentId]">) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const notFound = () =>
    NextResponse.json(
      { code: "NOT_FOUND", message: "Document not found." },
      { status: 404, headers: NO_STORE },
    );
  try {
    const { documentId } = await ctx.params;
    if (!UUID.test(documentId)) return notFound();
    const supabase = await createSupabaseServerClient();
    const { data: claims } = await supabase.auth.getClaims();
    if (!claims?.claims?.sub) {
      return NextResponse.json(
        { code: "UNAUTHENTICATED", message: "Please sign in." },
        { status: 401, headers: NO_STORE },
      );
    }
    const doc = await getDocumentForDownload(documentId);
    if (!doc) return notFound();
    const { error: logError } = await supabase.rpc("log_document_access", {
      p_document_id: doc.id,
    });
    if (logError) return notFound();
    const { data, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(doc.storage_path, 60, { download: doc.original_filename });
    if (error || !data) return notFound();
    return NextResponse.redirect(data.signedUrl, { status: 303, headers: NO_STORE });
  } catch (error) {
    getLogger().error("document download failed", { requestId, error });
    return NextResponse.json(toPublicError(error, requestId), { status: 500, headers: NO_STORE });
  }
}
