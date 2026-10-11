/** "12.5000" -> "12.5", "-3.0000" -> "-3" (exact text, no float conversion). */
export function formatQty(v: string): string {
  if (!v.includes(".")) return v;
  const t = v.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
}
