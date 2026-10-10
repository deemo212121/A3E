import { ActionForm, Field } from "@/components/ui/action-form";
import { requestPasswordResetAction } from "@/features/auth/actions";

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <ActionForm action={requestPasswordResetAction} submitLabel="Send reset link">
        <Field label="Email" name="email" type="email" autoComplete="username" required />
      </ActionForm>
    </main>
  );
}
