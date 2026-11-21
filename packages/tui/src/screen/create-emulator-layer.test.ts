import { expect, onTestFinished, test } from 'bun:test';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
import { createSessionEmulator } from '../emulator/create-session-emulator';
import { createEmulatorLayer } from './create-emulator-layer';

async function setupTest() {
  const emulator = createSessionEmulator({
    cols: 4,
    rows: 3,
    readFacts: () => ({
      depth: 'truecolor',
      background: { red: 0, green: 0, blue: 0 },
      foreground: { red: 255, green: 255, blue: 255 },
      kittyKeyboard: false,
    }),
  });

  onTestFinished(() => {
    emulator.dispose();
  });

  await emulator.write('ab\r\ncd\r\nef');

  const frame = {
    now: 0,
    cols: 6,
    rows: 4,
    terminal: {
      depth: 'truecolor' as const,
      background: { red: 0, green: 0, blue: 0 },
      foreground: { red: 255, green: 255, blue: 255 },
      kittyKeyboard: false,
    },
  };

  return { emulator, frame };
}

test('#draw copies the emulator screen to the top left of the buffer', async () => {
  const ctx = await setupTest();

  const buffer = buildCellBuffer(6, 4);

  createEmulatorLayer({ readEmulator: () => ctx.emulator, isRowDrawn: () => true }).draw(
    buffer,
    ctx.frame,
  );

  expect([buffer.get(0, 0).ch, buffer.get(1, 1).ch, buffer.get(0, 2).ch]).toStrictEqual([
    'a',
    'd',
    'e',
  ]);
});

test('#draw blanks a wide grapheme whose second half falls past the last column', async () => {
  const ctx = await setupTest();

  await ctx.emulator.write('\u001B[1;3H界');

  const buffer = buildCellBuffer(3, 4);

  createEmulatorLayer({ readEmulator: () => ctx.emulator, isRowDrawn: () => true }).draw(buffer, {
    ...ctx.frame,
    cols: 3,
  });

  expect([buffer.get(1, 0).ch, buffer.get(2, 0).ch]).toStrictEqual(['b', ' ']);
});

test('#draw leaves the cells outside the emulator as they were', async () => {
  const ctx = await setupTest();

  const buffer = buildCellBuffer(6, 4);

  buffer.set(5, 3, { ...buffer.get(5, 3), ch: 'z' });

  createEmulatorLayer({ readEmulator: () => ctx.emulator, isRowDrawn: () => true }).draw(
    buffer,
    ctx.frame,
  );

  expect(buffer.get(5, 3).ch).toBe('z');
});

test('#draw leaves out a row that the layer does not draw', async () => {
  const ctx = await setupTest();

  const buffer = buildCellBuffer(6, 4);

  createEmulatorLayer({ readEmulator: () => ctx.emulator, isRowDrawn: (row) => row === 2 }).draw(
    buffer,
    ctx.frame,
  );

  expect([buffer.get(0, 0).ch, buffer.get(0, 2).ch]).toStrictEqual([' ', 'e']);
});

test('#draw draws nothing without an emulator', async () => {
  const ctx = await setupTest();

  const buffer = buildCellBuffer(6, 4);

  createEmulatorLayer({ readEmulator: () => null, isRowDrawn: () => true }).draw(buffer, ctx.frame);

  expect(buffer.get(0, 0).ch).toBe(' ');
});

test('#nextFrameAt asks for no frame', async () => {
  const ctx = await setupTest();

  expect(
    createEmulatorLayer({ readEmulator: () => ctx.emulator, isRowDrawn: () => true }).nextFrameAt(
      10,
    ),
  ).toBeNull();
});
