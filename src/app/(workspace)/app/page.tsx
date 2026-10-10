import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/primitives";
import { homeFor } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";

/** Home router: sends each user to their primary workspace. */
export default function HomePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const { facts } = await guardRoute("home");
  redirect(homeFor(facts));
  return null;
}
