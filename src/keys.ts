export const KEY = {
  tab: 0x09,
  ctrlC: 0x03,
  ctrlU: 0x15,
  esc: 0x1b,
  enter: 0x0d,
  backspace: 0x7f,
} as const;

export function isUp(buf: Buffer): boolean {
  return buf.toString() === '\u001B[A' || buf.toString() === '\u001BOA';
}

export function isDown(buf: Buffer): boolean {
  return buf.toString() === '\u001B[B' || buf.toString() === '\u001BOB';
}

export interface TextEditOptions {
  readonly isLeaderKey: (buf: Buffer) => boolean;

  // Only a screen with a list under its input answers the arrow keys; a
  // plain prompt treats them as unprintable noise.
  readonly moves: boolean;
}

export type TextEdit =
  | { readonly kind: 'none' }
  | { readonly kind: 'submit'; readonly value: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'leader' }
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'input'; readonly value: string };

/**
 * What one stdin chunk does to a text-entry screen, decided without touching
 * the screen. The caller owns the input string and applies the answer.
 */
export function planTextEdit(
  buf: Buffer,
  input: string,
  opts: Readonly<TextEditOptions>,
): TextEdit {
  // Pasted chunks arrive as one buffer: read it character by character so a
  // trailing newline still submits. Escape sequences stay intact.
  if (buf.length > 1 && buf[0] !== KEY.esc) {
    let value = input;

    for (const ch of buf.toString()) {
      const edit = planKeyEdit(Buffer.from(ch), value, opts);

      if (edit.kind === 'input') {
        value = edit.value;
        continue;
      }

      if (edit.kind !== 'none') {
        return edit;
      }
    }

    return value === input ? { kind: 'none' } : { kind: 'input', value };
  }

  return planKeyEdit(buf, input, opts);
}

function planKeyEdit(buf: Buffer, input: string, opts: Readonly<TextEditOptions>): TextEdit {
  if (buf[0] === KEY.esc && buf.length === 1) {
    return { kind: 'cancel' };
  }

  if (opts.isLeaderKey(buf)) {
    return { kind: 'leader' };
  }

  if (buf[0] === KEY.enter) {
    return { kind: 'submit', value: input };
  }

  if (buf[0] === KEY.backspace) {
    return { kind: 'input', value: input.slice(0, -1) };
  }

  if (buf[0] === KEY.ctrlU) {
    return { kind: 'input', value: '' };
  }

  if (opts.moves) {
    if (isDown(buf)) {
      return { kind: 'move', delta: 1 };
    }

    if (isUp(buf)) {
      return { kind: 'move', delta: -1 };
    }
  }

  const text = buf.toString();

  return isPrintable(text) ? { kind: 'input', value: input + text } : { kind: 'none' };
}

function isPrintable(text: string): boolean {
  for (const c of text) {
    if (c < ' ' || c === '\u007F') {
      return false;
    }
  }

  return true;
}
