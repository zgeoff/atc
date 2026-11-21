import { expect, test } from 'bun:test';
import { createInputModeTracker } from './create-input-mode-tracker';
import { formatInputModes } from './format-input-modes';

test.each([
  { name: 'nothing', written: '' },
  { name: 'mouse and encoding', written: '\u001B[?1003h\u001B[?1006h' },
  { name: 'the keyboard modes', written: '\u001B[?1h\u001B=\u001B[>4;1m' },
  { name: 'a kitty stack', written: '\u001B[>1u\u001B[>0u\u001B[>31u' },
  { name: 'the switches', written: '\u001B[?1007h\u001B[?2004h\u001B[?1004h\u001B[?2031h' },
])('#formatInputModes re-creates $name through a tracker', (row) => {
  const original = createInputModeTracker();
  const copy = createInputModeTracker();

  original.write(row.written);
  copy.write(formatInputModes(original.read()));

  expect(copy.read()).toStrictEqual(original.read());
});
