import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createSessionEmulator } from '../emulator/create-session-emulator';
import { createSessionStream } from './create-session-stream';

function setupTest() {
  const replies: string[] = [];
  const passed: string[] = [];
  let changes = 0;

  const stream = createSessionStream({
    createEmulator: (cols, rows) =>
      createSessionEmulator({
        cols,
        rows,
        readFacts: () => ({
          depth: 'truecolor',
          background: { red: 0, green: 0, blue: 0 },
          foreground: { red: 255, green: 255, blue: 255 },
          kittyKeyboard: false,
        }),
      }),
    onReply: (_key, bytes) => {
      replies.push(bytes);
    },
    onPassthrough: (sequence) => {
      passed.push(sequence);
    },
    onChange: () => {
      changes += 1;
    },
  });

  onTestFinished(() => {
    stream.end();
  });

  return {
    stream,
    replies,
    passed,
    readChanges: () => changes,
    readText: () => {
      const emulator = stream.readEmulator();

      return [0, 1, 2, 3, 4].map((col) => emulator?.readCell(col, 0).ch ?? '').join('');
    },
  };
}

test('#applyEvent writes the output of an attached session in the screen mode', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'screen', { cols: 20, rows: 5 });
  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-1', seq: 1, data: 'hello' });

  await waitFor(() => {
    expect(ctx.readText()).toBe('hello');
  });
});

test('#applyEvent drops the output of another session and of another daemon', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'screen', { cols: 20, rows: 5 });
  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-2', seq: 1, data: 'other' });
  ctx.stream.applyEvent('box', { ev: 'SessionOutput', sessionID: 's-1', seq: 1, data: 'far' });
  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-1', seq: 2, data: 'mine' });

  await waitFor(() => {
    expect(ctx.readText()).toBe('mine ');
  });
});

test('#applyEvent drops output that arrives before the replay in the full mode', () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'full', { cols: 20, rows: 5 });
  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-1', seq: 1, data: 'early' });

  expect(ctx.readText()).toBe('     ');
});

test('#applyEvent draws a replay only after its last chunk', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'full', { cols: 20, rows: 5 });

  ctx.stream.applyEvent(null, {
    ev: 'SessionReplay',
    sessionID: 's-1',
    seq: 4,
    data: 'ab',
    done: false,
  });

  expect(ctx.stream.isSettled()).toBe(false);

  ctx.stream.applyEvent(null, {
    ev: 'SessionReplay',
    sessionID: 's-1',
    seq: 4,
    data: 'cd',
    done: true,
  });

  await waitFor(() => {
    expect([ctx.readText(), ctx.stream.isSettled()]).toStrictEqual(['abcd ', true]);
  });
});

test('#applyEvent applies only the output after the replay', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'full', { cols: 20, rows: 5 });

  ctx.stream.applyEvent(null, {
    ev: 'SessionReplay',
    sessionID: 's-1',
    seq: 4,
    data: 'ab',
    done: true,
  });

  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-1', seq: 4, data: 'XX' });
  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-1', seq: 5, data: 'cd' });

  await waitFor(() => {
    expect(ctx.readText()).toBe('abcd ');
  });
});

test('#applyEvent resets the emulator on the first chunk of a replay after a desync', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'full', { cols: 20, rows: 5 });

  ctx.stream.applyEvent(null, {
    ev: 'SessionReplay',
    sessionID: 's-1',
    seq: 1,
    data: 'old',
    done: true,
  });

  ctx.stream.applyEvent(null, { ev: 'SessionDesync', sessionID: 's-1' });
  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-1', seq: 9, data: 'stale' });

  ctx.stream.applyEvent(null, {
    ev: 'SessionReplay',
    sessionID: 's-1',
    seq: 9,
    data: 'new',
    done: true,
  });

  await waitFor(() => {
    expect(ctx.readText()).toBe('new  ');
  });
});

test('#applyEvent resizes the emulator on a resize event', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'screen', { cols: 20, rows: 5 });
  ctx.stream.applyEvent(null, { ev: 'SessionResized', sessionID: 's-1', cols: 33, rows: 7 });

  await waitFor(() => {
    expect(ctx.stream.readEmulator()?.readSize()).toStrictEqual({ cols: 33, rows: 7 });
  });
});

test('#applyEvent applies a resize that arrives behind a replay after the replay is parsed', async () => {
  const ctx = setupTest();
  const replay = `top\r\n${'w'.repeat(25)}\r\n${'x'.repeat(5000)}\u001B[2;3Hhere`;

  const direct = createSessionEmulator({
    cols: 20,
    rows: 5,
    readFacts: () => ({
      depth: 'truecolor',
      background: { red: 0, green: 0, blue: 0 },
      foreground: { red: 255, green: 255, blue: 255 },
      kittyKeyboard: false,
    }),
  });

  onTestFinished(() => {
    direct.dispose();
  });

  await direct.write(replay);
  await direct.resize(30, 5);

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'full', { cols: 20, rows: 5 });

  ctx.stream.applyEvent(null, {
    ev: 'SessionReplay',
    sessionID: 's-1',
    seq: 1,
    data: replay,
    done: true,
  });

  ctx.stream.applyEvent(null, { ev: 'SessionResized', sessionID: 's-1', cols: 30, rows: 5 });

  await waitFor(() => {
    expect(ctx.stream.isSettled()).toBeTrue();
  });

  const [actual, expected] = [ctx.stream.readEmulator(), direct].map((emulator) =>
    [0, 1, 2, 3, 4].map((row) =>
      Array.from({ length: 30 }, (_, col) => emulator?.readCell(col, row).ch ?? '').join(''),
    ),
  );

  expect(actual).toStrictEqual(expected);
});

test('#begin sends the answers of the emulator to the session', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'screen', { cols: 20, rows: 5 });

  ctx.stream.applyEvent(null, {
    ev: 'SessionOutput',
    sessionID: 's-1',
    seq: 1,
    data: 'ab\u001B[6n',
  });

  await waitFor(() => {
    expect(ctx.replies).toStrictEqual(['\u001B[1;3R']);
  });
});

test('#begin passes on a notification of the session', async () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'screen', { cols: 20, rows: 5 });

  ctx.stream.applyEvent(null, {
    ev: 'SessionOutput',
    sessionID: 's-1',
    seq: 1,
    data: '\u001B]9;done\u0007',
  });

  await waitFor(() => {
    expect(ctx.passed).toStrictEqual(['\u001B]9;done\u0007']);
  });
});

test('#end drops the emulator and the events that follow', () => {
  const ctx = setupTest();

  ctx.stream.begin({ daemon: null, id: 's-1' }, 'screen', { cols: 20, rows: 5 });
  ctx.stream.end();
  ctx.stream.applyEvent(null, { ev: 'SessionOutput', sessionID: 's-1', seq: 1, data: 'late' });

  expect(ctx.stream.readEmulator()).toBeNull();
});
