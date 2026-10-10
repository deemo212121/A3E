import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/primitives";
import { ProfileView } from "@/features/intake/profile-view";
import { renderClientPortalPage } from "@/features/portal/client-page";

export const metadata: Metadata = { title: "Business profile" };

export default function ProfilePage({ params }: PageProps<"/portal/[clientId]/profile">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Profile params={params} />
    </Suspense>
  );
}

async function Profile({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage(
    "portal.profile",
    clientId,
    "Business profile",
    ({ access, client }) => <ProfileView access={access} clientId={client.id} />,
  );
}
