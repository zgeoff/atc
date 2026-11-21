import type { InputModes } from '@atc/core';

const ESC = '\u001B';

// The sequences that take the user's terminal from the modes it holds to the modes it should
// hold. The kitty flags are set with `CSI = flags u`, never pushed, so the terminal holds no stack
// entry of ours, and none is sent to a terminal without the protocol.
export function formatModeTransition(
  from: InputModes,
  to: InputModes,
  kittyKeyboard: boolean,
): string {
  const keypad = to.applicationKeypad ? `${ESC}=` : `${ESC}>`;
  const kittyFlags = to.kittyStack.at(-1) ?? 0;
  const isKittyChanged = kittyKeyboard && (from.kittyStack.at(-1) ?? 0) !== kittyFlags;

  return [
    formatSwitch(from.applicationCursorKeys, to.applicationCursorKeys, [1]),
    from.applicationKeypad === to.applicationKeypad ? '' : keypad,
    formatMouse(from, to),
    formatSwitch(from.alternateScroll, to.alternateScroll, [1007]),
    formatSwitch(from.bracketedPaste, to.bracketedPaste, [2004]),
    formatSwitch(from.focusEvents, to.focusEvents, [1004]),
    formatSwitch(from.colourSchemeUpdates, to.colourSchemeUpdates, [2031]),
    from.modifyOtherKeys === to.modifyOtherKeys ? '' : `${ESC}[>4;${to.modifyOtherKeys}m`,
    isKittyChanged ? `${ESC}[=${kittyFlags};1u` : '',
  ].join('');
}

function formatSwitch(wasOn: boolean, isOn: boolean, modes: readonly number[]): string {
  if (wasOn === isOn) {
    return '';
  }

  const final = isOn ? 'h' : 'l';

  return modes.map((mode) => `${ESC}[?${mode}${final}`).join('');
}

const MOUSE_REPORTING: Record<InputModes['mouse'], number[]> = {
  off: [],
  click: [1000],
  drag: [1002],
  any: [1003],
};

const MOUSE_ENCODING: Record<InputModes['mouseEncoding'], number[]> = {
  default: [],
  sgr: [1006],
  urxvt: [1015],
};

function formatMouse(from: InputModes, to: InputModes): string {
  const reporting =
    from.mouse === to.mouse
      ? ''
      : formatSwitch(true, false, MOUSE_REPORTING[from.mouse]) +
        formatSwitch(false, true, MOUSE_REPORTING[to.mouse]);

  const encoding =
    from.mouseEncoding === to.mouseEncoding
      ? ''
      : formatSwitch(true, false, MOUSE_ENCODING[from.mouseEncoding]) +
        formatSwitch(false, true, MOUSE_ENCODING[to.mouseEncoding]);

  return reporting + encoding;
}
