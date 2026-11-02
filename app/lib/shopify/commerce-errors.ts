// PRD Pain 4: Commerce Account pre-check. {{IE_}} → human message + fallback.
export const COMMERCE_ERRORS: Record<string, string> = {
  IE_30007: "Catalog not approved — fix in Commerce Manager.",
  IE_30002: "Domain mismatch — verify domain in Business Manager.",
  IE_30010: "Commerce Account under review — use on-site widget meanwhile.",
};

export function humanizeCommerceError(raw: string): string {
  const m = raw.match(/IE_\d{5}/);
  if (!m) return raw;
  return COMMERCE_ERRORS[m[0]] ?? "Commerce Account issue — check Commerce Manager.";
}
