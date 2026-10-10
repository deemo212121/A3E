import { NotFoundState } from "@/components/ui/access-states";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto w-full max-w-xl flex-1 px-4">
      <NotFoundState marker="unknown-page" />
    </main>
  );
}
