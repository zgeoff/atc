export function normalizeClientName(
  raw: unknown,
  fallback = 'unnamed client',
  maxLength = 100,
): string {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const folded = raw
    .replaceAll(/[\t\n\v\f\r]/gu, ' ')
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim();

  // The cut counts code points, so it never splits a surrogate pair.
  const cut = folded.replace(new RegExp(`^(?<kept>.{${maxLength}}).+$`, 'su'), '$<kept>').trim();

  return cut === '' ? fallback : cut;
}
