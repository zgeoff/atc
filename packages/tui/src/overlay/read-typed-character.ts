// The one printable character a key press holds, or null for a control key, an escape sequence or
// a paste of several characters.
export function readTypedCharacter(buf: Buffer): string | null {
  const text = buf.toString();
  const codePoint = text.codePointAt(0);

  if (codePoint === undefined) {
    return null;
  }

  const character = String.fromCodePoint(codePoint);

  if (character.length !== text.length) {
    return null;
  }

  return character < ' ' || character === '\u007F' ? null : character;
}
