/** Synthetic access personas shared by the policy and tour tests. */
import type { AccessFacts } from "./route-policy";

export const A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const B = "bbbbbbbb-0000-4000-8000-00000000000b";

const none: AccessFacts = { firmRole: null, clientMemberships: [], staffClientIds: [] };
const m = (clientId: string, role: "client_owner" | "client_staff" | "client_viewer") => ({
  clientId,
  role,
  displayName: clientId === A ? "Client A" : "Client B",
  code: clientId === A ? "A" : "B",
});

export const PERSONAS: Record<string, AccessFacts> = {
  outsider: none,
  ownerA: { ...none, clientMemberships: [m(A, "client_owner")] },
  staffA: { ...none, clientMemberships: [m(A, "client_staff")] },
  viewerA: { ...none, clientMemberships: [m(A, "client_viewer")] },
  ownerAandB: { ...none, clientMemberships: [m(A, "client_owner"), m(B, "client_viewer")] },
  firmAdmin: { ...none, firmRole: "firm_admin" },
  manager: { ...none, firmRole: "firm_manager", staffClientIds: [A, B] },
  reviewerA: { ...none, firmRole: "reviewer", staffClientIds: [A], payrollClientIds: [A] },
  accountantB: { ...none, firmRole: "accountant", staffClientIds: [B] },
  bookkeeperNone: { ...none, firmRole: "bookkeeper" },
};
