export const ROLE_LABELS: Record<string, string> = {
  firm_admin: "Firm admin",
  firm_manager: "Firm manager",
  reviewer: "Reviewer",
  accountant: "Accountant",
  bookkeeper: "Bookkeeper",
  client_owner: "Owner",
  client_staff: "Staff",
  client_viewer: "Viewer",
  preparer: "Preparer",
};

export function roleLabel(role: string | null | undefined): string {
  return role ? (ROLE_LABELS[role] ?? role) : "—";
}

export function formatManila(iso: string): string {
  return new Date(iso).toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}
