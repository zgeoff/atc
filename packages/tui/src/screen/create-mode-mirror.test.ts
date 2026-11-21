import { expect, test } from 'bun:test';
import { NO_INPUT_MODES } from '@atc/core';
import type { InputModes } from '@atc/core';
import { createModeMirror } from './create-mode-mirror';

function setupTest() {
  const written: string[] = [];

  const state: { modes: InputModes | null; isFocused: boolean; hasKitty: boolean } = {
    modes: null,
    isFocused: true,
    hasKitty: false,
  };

  const mirror = createModeMirror({
    write: (chunk) => {
      written.push(chunk);
    },
    hasKittyKeyboard: () => state.hasKitty,
    readSessionModes: () => state.modes,
    isSessionFocused: () => state.isFocused,
  });

  return { mirror, written, state };
}

test('#sync puts the terminal into the modes of the focused session', () => {
  const ctx = setupTest();

  ctx.state.modes = { ...NO_INPUT_MODES, bracketedPaste: true, applicationCursorKeys: true };

  ctx.mirror.sync();

  expect(ctx.written).toStrictEqual(['\u001B[?1h\u001B[?2004h']);
});

test('#sync writes nothing when the modes did not change', () => {
  const ctx = setupTest();

  ctx.state.modes = { ...NO_INPUT_MODES, bracketedPaste: true };

  ctx.mirror.sync();
  ctx.mirror.sync();

  expect(ctx.written).toHaveLength(1);
});

test('#sync takes the modes off the terminal when another layer has focus', () => {
  const ctx = setupTest();

  ctx.state.modes = { ...NO_INPUT_MODES, bracketedPaste: true, mouse: 'any' };

  ctx.mirror.sync();

  ctx.state.isFocused = false;

  ctx.mirror.sync();

  expect(ctx.written.at(-1)).toBe('\u001B[?1003l\u001B[?2004l');
});

test('#sync sets the kitty flags to 0 on focus loss with a set, never a pop', () => {
  const ctx = setupTest();

  ctx.state.hasKitty = true;
  ctx.state.modes = { ...NO_INPUT_MODES, kittyStack: [1, 5] };

  ctx.mirror.sync();

  ctx.state.isFocused = false;

  ctx.mirror.sync();

  expect(ctx.written).toStrictEqual(['\u001B[=5;1u', '\u001B[=0;1u']);
});

test('#sync sends no kitty sequence to a terminal without the protocol', () => {
  const ctx = setupTest();

  ctx.state.modes = { ...NO_INPUT_MODES, kittyStack: [1] };

  ctx.mirror.sync();

  expect(ctx.written).toStrictEqual([]);
});

test('#reset takes every mirrored mode off the terminal', () => {
  const ctx = setupTest();

  ctx.state.modes = { ...NO_INPUT_MODES, focusEvents: true };

  ctx.mirror.sync();
  ctx.mirror.reset();

  expect(ctx.written.at(-1)).toBe('\u001B[?1004l');
});

test('#sync sets the kitty flags once the late kitty answer of the terminal arrives', () => {
  const ctx = setupTest();

  ctx.state.modes = { ...NO_INPUT_MODES, kittyStack: [1] };

  ctx.mirror.sync();

  ctx.state.hasKitty = true;

  ctx.mirror.sync();

  expect(ctx.written).toStrictEqual(['\u001B[=1;1u']);
});
