// The most characters of a field a log line keeps; a longer one is cut and
// ends in `...`.
const MAX_FIELD_CHARS = 64;

/**
 * Formats a value for one `key=value` field of a log line. Every character
 * outside printable ASCII, and a space, `"`, `=`, or `\`, is written as a
 * `\u{hex}` escape, so a value from the network can neither move the
 * terminal, start a new line, nor forge another field. The value is cut to
 * 64 characters before it is escaped.
 */
export function formatLogField(value: string): string {
  let formatted = '';
  let kept = 0;

  // Iterating a string steps by code point, so a character outside the
  // basic plane counts and escapes as one.
  for (const char of value) {
    if (kept === MAX_FIELD_CHARS) {
      return `${formatted}...`;
    }

    formatted += isPlainChar(char) ? char : formatEscape(char);
    kept++;
  }

  return formatted;
}

function isPlainChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;

  return code > 0x20 && code < 0x7f && char !== '"' && char !== '=' && char !== '\\';
}

function formatEscape(char: string): string {
  return `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`;
}
