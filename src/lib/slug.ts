/**
 * URL-safe slugs from arbitrary business names.
 *
 * Businesses onboarded here may be named in any language, so the input is
 * normalised to NFKD and stripped of combining marks before ASCII filtering —
 * "Café Noël" becomes "cafe-noel" rather than "caf-no-l".
 */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .toLowerCase()
    // Apostrophes are dropped rather than hyphenated, so "Owner's Workspace"
    // slugs to `owners-workspace` and not `owner-s-workspace`.
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > maxLength ? slug.slice(0, maxLength).replace(/-+$/g, '') : slug;
}
