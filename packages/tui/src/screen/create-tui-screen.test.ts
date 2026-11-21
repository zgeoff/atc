import { expect, onTestFinished, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createTUIScreen } from './create-tui-screen';

function setupTest() {
  const clock = buildStubClock(1000);
  const written: string[] = [];
  const state = { isFocused: false };

  const screen = createTUIScreen({
    clock,
    write: (chunk) => {
      written.push(chunk);
    },
    readSize: () => ({ cols: 20, rows: 6 }),
    env: { colorterm: 'truecolor', term: 'xterm' },
    animations: true,
    isSessionFocused: () => state.isFocused,
    sendSessionReply: () => {},
  });

  onTestFinished(() => {
    screen.stop();
  });

  return { clock, screen, written, state };
}

test('#writeScreen draws the text in one synchronized write on the next frame', async () => {
  const ctx = setupTest();

  ctx.screen.writeScreen('\u001B[2;3Hhello');

  await waitFor(() => {
    ctx.clock.advance(20);

    expect(ctx.written.join('')).toInclude('\u001B[2;3Hhello');
  });

  expect(ctx.written.at(-1)).toEndWith('\u001B[?2026l');
});

test('#filterInput takes the answers to the start-up questions out of the keys', () => {
  const ctx = setupTest();

  ctx.screen.start();

  expect(
    ctx.screen
      .filterInput(Buffer.from('\u001B]11;rgb:0000/0000/0000\u0007a\u001B[?0u'))
      ?.toString(),
  ).toBe('a');
});

test('#filterInput takes an answer out of the keys after the wait for answers ended', () => {
  const ctx = setupTest();

  ctx.screen.start();
  ctx.clock.advance(200);

  expect(
    ctx.screen.filterInput(Buffer.from('\u001B]10;rgb:ffff/ffff/ffff\u001B\\b'))?.toString(),
  ).toBe('b');
});

test('#filterInput gives null for a chunk that holds only answers', () => {
  const ctx = setupTest();

  expect(ctx.screen.filterInput(Buffer.from('\u001B[?62;4c'))).toBeNull();
});

test('#filterInput passes keys byte for byte', () => {
  const ctx = setupTest();

  expect(
    ctx.screen.filterInput(Buffer.from([0x00, 0x1b, 0x5b, 0x41, 0xe4, 0xb8, 0x96])),
  ).toStrictEqual(Buffer.from([0x00, 0x1b, 0x5b, 0x41, 0xe4, 0xb8, 0x96]));
});

test('#start asks the terminal for its colours and its keyboard protocol', () => {
  const ctx = setupTest();

  ctx.screen.start();

  expect(ctx.written[0]).toBe('\u001B]10;?\u001B\\\u001B]11;?\u001B\\\u001B[?u\u001B[c');
});

test('#stop takes the mirrored modes off the terminal', async () => {
  const ctx = setupTest();

  ctx.state.isFocused = true;

  ctx.screen.stream.begin({ daemon: null, id: 's-1' }, 'screen', { cols: 20, rows: 5 });

  ctx.screen.stream.applyEvent(null, {
    ev: 'SessionOutput',
    sessionID: 's-1',
    seq: 1,
    data: '\u001B[?2004h',
  });

  await waitFor(() => {
    ctx.screen.syncModes();

    expect(ctx.written.join('')).toInclude('\u001B[?2004h');
  });

  ctx.screen.stop();

  expect(ctx.written.at(-1)).toBe('\u001B[?2004l');
});
