// The one printable character a key press holds, or null for a control key, an escape sequence or
// a paste of several characters.
export function readTypedCharacter(buf: Buffer): string | null {
  const characters = [...buf.toString()];
  const [character] = characters;

  if (characters.length !== 1 || character === undefined) {
    return null;
  }

  return character < ' ' || character === '\u007F' ? null : character;
}
