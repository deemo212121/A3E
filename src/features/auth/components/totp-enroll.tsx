"use client";

import { useActionState } from "react";

import { ActionForm, Field } from "@/components/ui/action-form";
import { startTotpEnrollmentAction, verifyTotpAction } from "@/features/auth/mfa-actions";

/** Two-step enrollment: generate a TOTP secret (QR), then verify a code. */
export function TotpEnroll() {
  const [state, startAction, pending] = useActionState(startTotpEnrollmentAction, null);

  if (!state || !state.ok) {
    return (
      <form action={startAction} className="flex flex-col gap-3">
        <p className="text-sm">
          Staff accounts must use an authenticator app (for example Google Authenticator or
          Microsoft Authenticator).
        </p>
        <button
          type="submit"
          disabled={pending}
          className="w-fit rounded border border-[var(--border)] px-3 py-1.5 disabled:opacity-50"
        >
          {pending ? "Preparing…" : "Set up authenticator app"}
        </button>
        {state && !state.ok ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error.message}
          </p>
        ) : null}
      </form>
    );
  }

  const { factorId, qrCode, secret } = state.data;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">Scan this QR code with your authenticator app:</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URL from Supabase */}
      <img
        src={qrCode}
        alt="Authenticator QR code"
        width={180}
        height={180}
        className="bg-white p-2"
      />
      <p className="text-xs text-[var(--muted)]">
        Or enter this key manually: <code className="break-all">{secret}</code>
      </p>
      <ActionForm action={verifyTotpAction} submitLabel="Verify and continue">
        <input type="hidden" name="factorId" value={factorId} />
        <Field label="6-digit code" name="code" autoComplete="one-time-code" required />
      </ActionForm>
    </div>
  );
}
