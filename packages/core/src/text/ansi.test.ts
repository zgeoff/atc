import { expect, test } from 'bun:test';
import { ansi } from './ansi';

test('it moves the cursor to a one-based row and column', () => {
  expect(ansi.moveTo(3, 7)).toBe('\u001B[3;7H');
});

test('it clears the screen by erasing it, then homing the cursor', () => {
  expect(ansi.clear).toBe(`${ansi.eraseScreen}${ansi.cursorHome}`);
});
