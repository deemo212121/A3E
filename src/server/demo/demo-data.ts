import "server-only";

import { getServerEnv } from "@/lib/env/server";

/**
 * DEMO DATA: synthetic rows used ONLY to review layouts of screens whose real
 * features arrive in later phases. Never stored in the database, never shown
 * in production, and always rendered inside <DemoNotice>.
 */
export function demoEnabled(): boolean {
  return getServerEnv().APP_ENV !== "production";
}

export const DEMO_REVIEW_QUEUE = [
  {
    id: "demo-r1",
    item: "Journal entry JE-DEMO-0001",
    client: "DEMO Sampaguita Trading",
    preparedBy: "DEMO Preparer",
    status: "Submitted",
  },
  {
    id: "demo-r2",
    item: "Journal entry JE-DEMO-0002",
    client: "DEMO Narra Services Corp.",
    preparedBy: "DEMO Preparer",
    status: "Submitted",
  },
  {
    id: "demo-r3",
    item: "Period close (DEMO month)",
    client: "DEMO Sampaguita Trading",
    preparedBy: "DEMO Preparer",
    status: "Awaiting review",
  },
] as const;

export const DEMO_WORK_QUEUE = [
  {
    id: "demo-w1",
    task: "Record uploaded purchase invoices",
    client: "DEMO Sampaguita Trading",
    due: "DEMO date",
  },
  {
    id: "demo-w2",
    task: "Follow up missing bank statement",
    client: "DEMO Narra Services Corp.",
    due: "DEMO date",
  },
] as const;

export const DEMO_DOCUMENTS = [
  {
    id: "demo-d1",
    name: "DEMO-sales-invoice-0001.pdf",
    category: "Sales invoice",
    status: "Uploaded",
  },
  {
    id: "demo-d2",
    name: "DEMO-bank-statement.pdf",
    category: "Bank statement",
    status: "Needs info",
  },
] as const;

export const DEMO_REQUESTS = [
  {
    id: "demo-q1",
    title: "DEMO: Please upload the bank statement",
    status: "Open",
    due: "DEMO date",
  },
  {
    id: "demo-q2",
    title: "DEMO: Confirm the supplier's TIN",
    status: "Answered",
    due: "DEMO date",
  },
] as const;
