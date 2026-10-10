import { signOutAction } from "@/features/auth/actions";

export default function AccountDisabledPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-16">
      <h1 className="text-2xl font-semibold">Account disabled</h1>
      <p>Your account has been disabled. Contact your accounting firm&apos;s administrator.</p>
      <form action={signOutAction}>
        <button type="submit" className="rounded border border-[var(--border)] px-3 py-1.5">
          Sign out
        </button>
      </form>
    </main>
  );
}
