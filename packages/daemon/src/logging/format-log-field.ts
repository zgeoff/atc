const MAX_FIELD_CHARS = 64;

// Values come from the network. Escaping keeps them from moving the terminal, starting a new
// line, or forging another field.
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
