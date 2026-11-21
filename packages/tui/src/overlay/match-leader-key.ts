const ESC = '\u001B';

// CSI 27 ; modifiers ; code ~
const OTHER_KEYS = new RegExp(`^${ESC}\\[27;(?<modifiers>\\d+);(?<code>\\d+)~$`, 'u');

// CSI code[:shifted[:base layout]] ; modifiers[:event] [; text] u
const KITTY_KEY = new RegExp(
  `^${ESC}\\[(?<code>\\d+)(?::\\d*){0,2};(?<modifiers>\\d+)(?::(?<event>\\d))?(?:;[\\d:]*)?u$`,
  'u',
);

// A fullscreen session can leave the terminal in the kitty keyboard protocol or in xterm's
// modifyOtherKeys, so the leader arrives as a CSI sequence in place of its control byte.
export function matchLeaderKey(code: number, data: string): 'press' | 'release' | null {
  if (data === String.fromCodePoint(code)) {
    return 'press';
  }

  const base = pickBaseCodePoint(code);
  const otherKeys = OTHER_KEYS.exec(data)?.groups;

  if (otherKeys !== undefined) {
    return isControlOnly(otherKeys['modifiers']) && Number(otherKeys['code']) === base
      ? 'press'
      : null;
  }

  const kitty = KITTY_KEY.exec(data)?.groups;

  if (kitty === undefined || Number(kitty['code']) !== base || !isControlOnly(kitty['modifiers'])) {
    return null;
  }

  return kitty['event'] === '3' ? 'release' : 'press';
}

// The enhanced encodings name the unshifted key, not the control byte it maps to.
function pickBaseCodePoint(code: number): number {
  if (code === 0) {
    return 32;
  }

  return code <= 26 ? code + 96 : code + 64;
}

// The modifier field is one more than the bit mask of ctrl (4), plus the lock bits caps (64) and
// num lock (128), which do not change the key.
function isControlOnly(modifiers: string | undefined): boolean {
  return ((Number(modifiers) - 1) & ~(64 | 128)) === 4;
}
