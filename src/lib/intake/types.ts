/** One entry in a record's history: a status change or a comment. */
export interface TimelineItem {
  kind: "event" | "comment";
  at: string;
  actor: string;
  from?: string | null;
  to?: string;
  text: string | null;
  internal?: boolean;
}
