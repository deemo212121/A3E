import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ActionForm, Field } from "@/components/ui/action-form";
import { TotpEnroll } from "@/features/auth/components/totp-enroll";
import { verifyTotpAction } from "@/features/auth/mfa-actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default function MfaPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Two-step verification</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <MfaStep />
      </Suspense>
    </main>
  );
}

async function MfaStep() {
  const supabase = await createSupabaseServerClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") redirect("/app");

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = factors?.totp?.[0];

  if (verified) {
    return (
      <ActionForm action={verifyTotpAction} submitLabel="Verify">
        <p className="text-sm">Enter the 6-digit code from your authenticator app.</p>
        <input type="hidden" name="factorId" value={verified.id} />
        <Field label="6-digit code" name="code" autoComplete="one-time-code" required />
      </ActionForm>
    );
  }
  return <TotpEnroll />;
}
