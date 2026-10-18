export const STATUS_TONE: Record<string, "neutral" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  pending_review: "warning",
  approved: "success",
  rejected: "danger",
  retired: "neutral",
  computed: "warning",
  reviewed: "success",
  superseded: "neutral",
  unsupported: "danger",
  not_applicable: "neutral",
  manual_review: "danger",
};

export const COMPUTATION_HELP: Record<string, string> = {
  computed: "Computed from posted entries and adjustments; awaiting a reviewer.",
  reviewed: "Reviewed by a second person. Still a working paper, not a filed return.",
  superseded: "Replaced by a later computation for the same period.",
  unsupported:
    "No verified and approved rule covers this period. Prepare it manually with professional review.",
  not_applicable: "Not a configured obligation, or the client is not eligible under the rule.",
  manual_review: "Something the rule needs is missing or unclear; a professional must resolve it.",
};
