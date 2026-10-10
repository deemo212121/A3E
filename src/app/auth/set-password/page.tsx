import { ActionForm, Field } from "@/components/ui/action-form";
import { setPasswordAction } from "@/features/auth/actions";

export default function SetPasswordPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Set your password</h1>
      <p className="text-sm text-[var(--muted)]">
        At least 12 characters, with uppercase and lowercase letters and a number.
      </p>
      <ActionForm action={setPasswordAction} submitLabel="Save password">
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
        />
        <Field
          label="Confirm password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
        />
      </ActionForm>
    </main>
  );
}
