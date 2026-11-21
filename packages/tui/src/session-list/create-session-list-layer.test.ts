import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { BLANK_CELL } from '../compositor/blank-cell';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
import { createFrameClock } from '../compositor/create-frame-clock';
import type { CellBuffer } from '../compositor/types';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { createSessionListLayer } from './create-session-list-layer';

function setupTest(animations: boolean) {
  const clock = buildStubClock(1000);

  const state: {
    isOpen: boolean;
    canFadeOut: boolean;
    sessionState: 'done' | 'running';
    stateSince: number | null;
    cols: number;

    // how long the host takes to write a frame, which can carry the clock past the end of a fade
    drawStallMs: number;
  } = {
    isOpen: false,
    canFadeOut: true,
    sessionState: 'done',
    stateSince: null,
    cols: 100,
    drawStallMs: 0,
  };

  const frames: { readonly at: number; readonly buffer: CellBuffer }[] = [];

  const layer = createSessionListLayer({
    clock,
    animations,
    isOpen: () => state.isOpen,
    canFadeOut: () => state.canFadeOut,
    isOverSession: () => true,
    readInput: (nowMs, spinnerFrame) => ({
      rows: [
        {
          kind: 'session',
          session: buildMockMirrorSession({
            name: 'api',
            state: state.sessionState,
            stateSince: state.stateSince,
          }),
          via: null,
        },
      ],
      selected: 0,
      grouping: 'flat',
      filter: null,
      jump: null,
      prompt: null,
      notice: null,
      daemonLine: null,
      updateAdvice: null,
      showDaemon: false,
      nowMs,
      spinnerFrame,
      readAgentLabel: (session) => session.agent,
    }),
  });

  const frameClock = createFrameClock({
    clock,
    animations,
    collectLayers: () => (layer.isVisible() ? [layer] : []),
    drawFrame: () => {
      const buffer = buildCellBuffer(state.cols, 20);

      buffer.set(0, 0, { ...BLANK_CELL, ch: 'x' });
      buffer.set(0, 19, { ...BLANK_CELL, ch: 'y' });

      layer.draw(buffer, {
        now: clock.now(),
        cols: state.cols,
        rows: 20,
        terminal: {
          depth: 'truecolor',
          background: { red: 13, green: 17, blue: 23 },
          foreground: { red: 201, green: 209, blue: 217 },
          kittyKeyboard: false,
        },
      });

      frames.push({ at: clock.now(), buffer });
      clock.stall(state.drawStallMs);
    },
  });

  return { clock, state, frames, layer, frameClock };
}

test('it draws the open frame by frame until its one row has faded in at 260 ms, then asks for no more', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  const drawn = ctx.frames.length;

  ctx.clock.advance(1000);

  expect({
    firstAt: ctx.frames[0]?.at,
    lastAt: ctx.frames.at(-1)?.at,
    stopped: ctx.frames.length === drawn,
  }).toStrictEqual({ firstAt: 1000, lastAt: expect.toBeWithin(1260, 1290), stopped: true });
});

test('it draws the panel with no visible text in the first frame of the open', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(1);

  const corner = ctx.frames[0]?.buffer.get(4, 7);

  expect(corner?.fg).toStrictEqual(corner?.bg);
});

test('it draws the panel whole once the open has finished', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  const corner = ctx.frames.at(-1)?.buffer.get(4, 7);

  expect([corner?.ch, corner?.fg]).toStrictEqual([
    '╭',
    { kind: 'rgb', red: 42, green: 51, blue: 80 },
  ]);
});

test('it dims the layers below the panel but not the last row', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  const buffer = ctx.frames.at(-1)?.buffer;

  expect([buffer?.get(0, 0).fg.kind, buffer?.get(0, 19).fg.kind]).toStrictEqual(['rgb', 'default']);
});

test('it fades the panel out in 120 ms and then draws nothing of it', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  ctx.state.isOpen = false;

  ctx.frameClock.request();
  ctx.clock.advance(300);

  const buffer = ctx.frames.at(-1)?.buffer;

  expect({
    corner: buffer?.get(4, 7).ch,
    dimmed: buffer?.get(0, 0).fg.kind,
    isVisible: ctx.layer.isVisible(),
  }).toStrictEqual({ corner: ' ', dimmed: 'default', isVisible: false });
});

test('it draws the panel half faded 60 ms into the close', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  ctx.state.isOpen = false;

  ctx.frameClock.request();
  ctx.clock.advance(1);
  ctx.clock.advance(64);

  const corner = ctx.frames.at(-1)?.buffer.get(4, 7);

  expect(corner?.ch).toBe('╭');
});

test('it draws the screen without the panel when a frame of the close ends it', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  ctx.state.isOpen = false;
  ctx.state.drawStallMs = 200;

  ctx.frameClock.request();
  ctx.clock.advance(1000);

  expect(ctx.frames.at(-1)?.buffer.get(4, 7).ch).toBe(' ');
});

test('it opens whole in a single frame with animations off', () => {
  const ctx = setupTest(false);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(1000);

  const corner = ctx.frames[0]?.buffer.get(4, 7);

  expect({ frames: ctx.frames.length, fg: corner?.fg }).toStrictEqual({
    frames: 1,
    fg: { kind: 'rgb', red: 42, green: 51, blue: 80 },
  });
});

test('it closes in a single frame with animations off', () => {
  const ctx = setupTest(false);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(10);

  ctx.state.isOpen = false;

  ctx.frameClock.request();
  ctx.clock.advance(1000);

  expect({
    frames: ctx.frames.length,
    corner: ctx.frames.at(-1)?.buffer.get(4, 7).ch,
  }).toStrictEqual({
    frames: 2,
    corner: ' ',
  });
});

test('it leaves at once for a screen that takes over from the list', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  ctx.state.isOpen = false;
  ctx.state.canFadeOut = false;

  ctx.frameClock.request();
  ctx.clock.advance(1);

  expect(ctx.frames.at(-1)?.buffer.get(4, 7).ch).toBe(' ');
});

test('it keeps asking for frames at 10 Hz while a row shows a running session', () => {
  const ctx = setupTest(true);

  ctx.state.sessionState = 'running';
  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(1700);

  const lateTimes = ctx.frames.map((frame) => frame.at).filter((at) => at > 2200);

  expect(lateTimes).toStrictEqual([2300, 2400, 2500, 2600, 2700]);
});

test('it redraws a done row once a second, as its age steps, after the open has finished', () => {
  const ctx = setupTest(true);

  ctx.state.stateSince = 0;
  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(5000);

  const lateTimes = ctx.frames.map((frame) => frame.at).filter((at) => at > 1300);

  expect(lateTimes).toStrictEqual([2000, 3000, 4000, 5000, 6000]);
});

test('it starts the close from the fade the open had reached', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(112);

  const lastOpen = ctx.frames.at(-1);

  ctx.state.isOpen = false;

  ctx.frameClock.request();
  ctx.clock.advance(0);

  const firstClose = ctx.frames.at(-1);

  expect({
    at: firstClose?.at,
    corner: firstClose?.buffer.get(4, 7).fg,
    name: firstClose?.buffer.get(9, 8).fg,
  }).toStrictEqual({
    at: lastOpen?.at,
    corner: lastOpen?.buffer.get(4, 7).fg,
    name: lastOpen?.buffer.get(9, 8).fg,
  });
});

test('it starts the reopen from the fade the close had reached', () => {
  const ctx = setupTest(true);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  ctx.state.isOpen = false;

  ctx.frameClock.request();
  ctx.clock.advance(48);

  const lastClose = ctx.frames.at(-1);

  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(0);

  const firstReopen = ctx.frames.at(-1);

  expect({
    at: firstReopen?.at,
    corner: firstReopen?.buffer.get(4, 7).fg,
    name: firstReopen?.buffer.get(9, 8).fg,
  }).toStrictEqual({
    at: lastClose?.at,
    corner: lastClose?.buffer.get(4, 7).fg,
    name: lastClose?.buffer.get(9, 8).fg,
  });
});

test('it centres a closing panel in the size the terminal shrank to', () => {
  const ctx = setupTest(true);

  ctx.state.cols = 200;
  ctx.state.isOpen = true;

  ctx.frameClock.request();
  ctx.clock.advance(700);

  ctx.state.isOpen = false;

  ctx.frameClock.request();
  ctx.clock.advance(20);

  ctx.state.cols = 60;

  ctx.frameClock.request();
  ctx.clock.advance(0);

  expect(ctx.frames.at(-1)?.buffer.get(4, 7).ch).toBe('╭');
});
