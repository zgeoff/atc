/**
 * Folds a client-supplied name to a single printable terminal line: control
 * and format characters (escape sequences, line breaks, bidi overrides) are
 * dropped, whitespace runs become one space, and the result is trimmed and
 * cut to 100 characters. A name with nothing left becomes the fallback.
 */
export function normalizeClientName(raw: unknown, fallback = 'unnamed client'): string {
  if (typeof raw !== 'string') {
    return fallback;
  }

  const folded = raw
    .replaceAll(/[\t\n\v\f\r]/g, ' ')
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim();

  // The cut counts code points, so it never splits a surrogate pair.
  const cut = folded.replace(/^(?<kept>.{100}).+$/su, '$<kept>').trim();

  return cut === '' ? fallback : cut;
}
