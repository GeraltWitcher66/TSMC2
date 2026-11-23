/** Validate the provider's whole-instrument major-holder register before
 * treating absence of individual rows as a genuine zero. */
export type IndividualHolderCount =
  | { count: number; status: "verified" | "verified-zero"; sourceDate: null }
  | { count: null; status: "invalid-source"; sourceDate: null };

const normalizeName = (name: string) => name
  .replace(/ك/g, "ک").replace(/ي/g, "ی")
  .replace(/[\u200c\u200f\ufeff\s]+/g, "").trim();

const ID_FIELDS = ["shareholderId", "shareholderID", "shareHolderId", "shareholderCode", "shareholder_id", "id"] as const;

export function countMajorIndividualHolders(payload: unknown): IndividualHolderCount {
  if (!Array.isArray(payload)) return { count: null, status: "invalid-source", sourceDate: null };
  const seen = new Set<string>();
  let count = 0;
  for (const candidate of payload) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { count: null, status: "invalid-source", sourceDate: null };
    const item = candidate as Record<string, unknown>;
    if (typeof item.name !== "string" || !normalizeName(item.name)) return { count: null, status: "invalid-source", sourceDate: null };
    // A row with invalid ownership quantities is not evidence of a complete
    // register; never report zero or a partially trusted count for it.
    if (item.shares === undefined || item.shares === null || !Number.isFinite(Number(item.shares)) || Number(item.shares) < 0)
      return { count: null, status: "invalid-source", sourceDate: null };
    if (normalizeName(item.name) !== "شخصحقیقی") continue;

    // A generic label is NOT a person identity. Separate anonymous rows
    // represent separate major holders unless the provider supplies a stable ID.
    const id = ID_FIELDS.map((key) => item[key]).find((value) =>
      (typeof value === "string" && value.trim() !== "") || (typeof value === "number" && Number.isSafeInteger(value) && value > 0));
    if (id !== undefined) {
      const key = String(id).trim();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    count++;
  }
  return { count, status: count === 0 ? "verified-zero" : "verified", sourceDate: null };
}
