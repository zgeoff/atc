import type { InputModes } from './create-input-mode-tracker';

// The escape sequences that put a terminal into the given modes, starting from a terminal that
// holds none of them. The kitty stack is re-created with one push per entry.
export function formatInputModes(modes: InputModes): string {
  const parts: string[] = [];

  if (modes.applicationCursorKeys) {
    parts.push('\u001B[?1h');
  }

  if (modes.applicationKeypad) {
    parts.push('\u001B=');
  }

  const reporting = { off: [], click: [1000], drag: [1002], any: [1003] }[modes.mouse];

  for (const mode of reporting) {
    parts.push(`\u001B[?${mode}h`);
  }

  const encoding = { default: [], sgr: [1006], urxvt: [1015] }[modes.mouseEncoding];

  for (const mode of encoding) {
    parts.push(`\u001B[?${mode}h`);
  }

  const switches: readonly [boolean, number][] = [
    [modes.alternateScroll, 1007],
    [modes.bracketedPaste, 2004],
    [modes.focusEvents, 1004],
    [modes.colourSchemeUpdates, 2031],
  ];

  for (const [isOn, mode] of switches) {
    if (isOn) {
      parts.push(`\u001B[?${mode}h`);
    }
  }

  for (const flags of modes.kittyStack) {
    parts.push(`\u001B[>${flags}u`);
  }

  if (modes.modifyOtherKeys > 0) {
    parts.push(`\u001B[>4;${modes.modifyOtherKeys}m`);
  }

  return parts.join('');
}
