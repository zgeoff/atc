const ESC = '\u001B';

// CSI 27 ; modifiers ; code ~
const OTHER_KEYS = new RegExp(`^${ESC}\\[27;(?<modifiers>\\d+);(?<code>\\d+)~$`, 'u');

// CSI code[:shifted[:base layout]] ; modifiers[:event] [; text] u
const KITTY_KEY = new RegExp(
  `^${ESC}\\[(?<code>\\d+)(?::(?<shifted>\\d*))?(?::\\d*)?;(?<modifiers>\\d+)(?::(?<event>\\d))?(?:;[\\d:]*)?u$`,
  'u',
);

const CTRL = 4;
const CTRL_SHIFT = 5;

// the key under each shifted character a control byte maps to, on a US layout: 6 under ^, - under _
const US_UNSHIFTED_KEYS = new Map([
  [94, 54],
  [95, 45],
]);

// A fullscreen session can leave the terminal in the kitty keyboard protocol or in xterm's
// modifyOtherKeys, so the leader arrives as a CSI sequence in place of its control byte.
export function matchLeaderKey(code: number, data: string): 'press' | 'release' | null {
  if (data === String.fromCodePoint(code)) {
    return 'press';
  }

  const base = pickBaseCodePoint(code);
  const unshifted = US_UNSHIFTED_KEYS.get(base);
  const otherKeys = OTHER_KEYS.exec(data)?.groups;

  if (otherKeys !== undefined) {
    const modifiers = readModifiers(otherKeys['modifiers']);

    const isMatch =
      Number(otherKeys['code']) === base &&
      (modifiers === CTRL || (unshifted !== undefined && modifiers === CTRL_SHIFT));

    return isMatch ? 'press' : null;
  }

  const kitty = KITTY_KEY.exec(data)?.groups;

  if (kitty === undefined) {
    return null;
  }

  const modifiers = readModifiers(kitty['modifiers']);
  const key = Number(kitty['code']);
  const isPlain = modifiers === CTRL && key === base;

  // ^ and _ need shift, so the protocol names the unshifted key and may add the shifted one
  const isShifted =
    modifiers === CTRL_SHIFT &&
    unshifted !== undefined &&
    (key === unshifted || Number(kitty['shifted']) === base);

  if (!isPlain && !isShifted) {
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

// The modifier field is one more than the bit mask of shift (1) and ctrl (4), plus the lock bits
// caps (64) and num lock (128), which do not change the key.
function readModifiers(modifiers: string | undefined): number {
  return (Number(modifiers) - 1) & ~(64 | 128);
}
