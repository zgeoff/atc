/**
 * Folds a client-supplied name to a single printable terminal line: control
 * and format characters (escape sequences, line breaks, bidi overrides) are
 * dropped, whitespace runs become one space, and the result is trimmed and
 * cut to `maxLength` characters. A name with nothing left becomes the
 * fallback. Any other client-supplied text bound for the terminal, such as a
 * user agent, folds the same way.
 */
export function normalizeClientName(
  raw: unknown,
  fallback = 'unnamed client',
  maxLength = 100,
): string {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const folded = raw
    .replaceAll(/[\t\n\v\f\r]/g, ' ')
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim();

  // The cut counts code points, so it never splits a surrogate pair.
  const cut = folded.replace(new RegExp(`^(?<kept>.{${maxLength}}).+$`, 'su'), '$<kept>').trim();

  return cut === '' ? fallback : cut;
}
