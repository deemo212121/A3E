import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field } from "@/components/ui/action-form";
import { Alert } from "@/components/ui/primitives";
import { signInAction } from "@/features/auth/actions";
import { safeNextPath } from "@/features/auth/schemas";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <Suspense fallback={<LoginForm next="/app" linkError={false} />}>
        <LoginWithParams searchParams={searchParams} />
      </Suspense>
      <p className="text-sm">
        <Link href="/auth/forgot" className="underline">
          Forgot your password?
        </Link>
      </p>
      <p className="text-xs text-[var(--muted)]">
        Accounts are by invitation only. Contact your accounting firm for access.
      </p>
    </main>
  );
}

async function LoginWithParams({
  searchParams,
}: {
  searchParams: PageProps<"/login">["searchParams"];
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  return <LoginForm next={next} linkError={params.error === "link"} />;
}

function LoginForm({ next, linkError }: { next: string; linkError: boolean }) {
  return (
    <>
      {linkError ? (
        <Alert tone="warning">
          That link is invalid or has expired. Sign in, or request a new one.
        </Alert>
      ) : null}
      <ActionForm action={signInAction} submitLabel="Sign in" toastOnSuccess={false}>
        <input type="hidden" name="next" value={next} />
        <Field label="Email" name="email" type="email" autoComplete="username" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </ActionForm>
    </>
  );
}
