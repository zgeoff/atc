import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './shared/report';
import { setupTempDir } from './test-utils/setup-temp-dir';

// The report subcommand against a listener standing in for the daemon's
// reporter socket; it must exit 0 on every path.
function setupTest() {
  const tmp = setupTempDir('atc-report-');
  const sock = join(tmp.dir, 'reporter.sock');
  const received = Promise.withResolvers<string>();
  let chunks = '';

  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, buf) {
        chunks += buf.toString();

        if (chunks.includes('\n')) {
          received.resolve(chunks);
          socket.end();
        }
      },
      open() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  return {
    dir: tmp.dir,
    sock,
    waitForLine: () => received.promise,
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it forwards an answered report with the final text from stdin', async () => {
  using listener = setupTest();

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'answered', '--message', 'm-1'],
    {
      stdin: new TextEncoder().encode('all done'),
      env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const [code, line] = await Promise.all([proc.exited, listener.waitForLine()]);

  expect(code).toBe(0);

  expect(JSON.parse(line)).toStrictEqual({
    atcId: 's1',
    event: 'Report',
    payload: { kind: 'answered', message: 'm-1', answer: 'all done' },
  });
});

test('it forwards an answered report with the turn that carried the message', async () => {
  using listener = setupTest();

  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'cli.ts'),
      'report',
      'answered',
      '--message',
      'm-1',
      '--turn',
      't-7',
    ],
    {
      stdin: new TextEncoder().encode('all done'),
      env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const [code, line] = await Promise.all([proc.exited, listener.waitForLine()]);

  expect(code).toBe(0);

  expect(JSON.parse(line)).toStrictEqual({
    atcId: 's1',
    event: 'Report',
    payload: { kind: 'answered', message: 'm-1', answer: 'all done', turn: 't-7' },
  });
});

test('it forwards one answered report for every message a turn answered', async () => {
  using listener = setupTest();

  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'cli.ts'),
      'report',
      'answered',
      '--messages',
      'm-1,m-2',
      '--turn',
      't-7',
    ],
    {
      stdin: new TextEncoder().encode('both done'),
      env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const [code, line] = await Promise.all([proc.exited, listener.waitForLine()]);

  expect(code).toBe(0);

  expect(JSON.parse(line)).toStrictEqual({
    atcId: 's1',
    event: 'Report',
    payload: { kind: 'answered', messages: ['m-1', 'm-2'], answer: 'both done', turn: 't-7' },
  });
});

test('it exits 0 when nothing listens at the socket', async () => {
  using tmp = setupTempDir('atc-report-empty-');

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'answered', '--message', 'm-1'],
    {
      stdin: new TextEncoder().encode('all done'),
      env: { ...process.env, ATC_SOCKET: join(tmp.dir, 'none.sock'), ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const code = await proc.exited;

  expect(code).toBe(0);
});

test('it exits 0 without a message id', async () => {
  using listener = setupTest();

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'answered'],
    {
      stdin: new TextEncoder().encode('all done'),
      env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const code = await proc.exited;

  expect(code).toBe(0);
});

test('it exits 0 for an unknown report kind', async () => {
  using listener = setupTest();

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'progress', '--message', 'm-1'],
    {
      stdin: new TextEncoder().encode('all done'),
      env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const code = await proc.exited;

  expect(code).toBe(0);
});

test('it forwards a note with its label and the text from stdin', async () => {
  using listener = setupTest();

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'note', '--label', 'blocked'],
    {
      stdin: new TextEncoder().encode('need review'),
      env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const [code, line] = await Promise.all([proc.exited, listener.waitForLine()]);

  expect(code).toBe(0);

  expect(JSON.parse(line)).toStrictEqual({
    atcId: 's1',
    event: 'Report',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });
});

test('it labels a note progress when no label is given', async () => {
  using listener = setupTest();

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'note'], {
    stdin: new TextEncoder().encode('halfway there'),
    env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const [code, line] = await Promise.all([proc.exited, listener.waitForLine()]);

  expect(code).toBe(0);

  expect(JSON.parse(line)).toStrictEqual({
    atcId: 's1',
    event: 'Report',
    payload: { kind: 'note', label: 'progress', text: 'halfway there' },
  });
});

test('it exits 0 for a note without text', async () => {
  using listener = setupTest();

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'note', '--label', 'blocked'],
    {
      stdin: new TextEncoder().encode('  \n'),
      env: { ...process.env, ATC_SOCKET: listener.sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const code = await proc.exited;

  expect(code).toBe(0);
});

test('it clears a bridge report from the outbox once the bridge refuses it as forbidden', async () => {
  using listener = setupTest();

  const sock = join(listener.dir, 'bridge.sock');
  const outbox = join(listener.dir, 'outbox');

  mkdirSync(outbox);

  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, buf) {
        const parsed: unknown = JSON.parse(buf.toString().split('\n')[0] ?? '{}');
        const id = isRecord(parsed) ? parsed['id'] : null;

        socket.write(`${JSON.stringify({ id, ok: false, code: 'forbidden' })}\n`);
      },
      open() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'note'], {
    stdin: new TextEncoder().encode('need review'),
    env: {
      ...process.env,
      ATC_BRIDGE: '1',
      ATC_SOCKET: sock,
      ATC_OUTBOX: outbox,
      ATC_SESSION_ID: 's1',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const code = await proc.exited;

  expect(code).toBe(0);
  expect(readdirSync(outbox)).toStrictEqual([]);
});

test('it keeps a bridge report in the outbox when the bridge never answers', async () => {
  using listener = setupTest();

  const sock = join(listener.dir, 'bridge.sock');
  const outbox = join(listener.dir, 'outbox');

  mkdirSync(outbox);

  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket) {
        socket.end();
      },
      open() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), 'report', 'note'], {
    stdin: new TextEncoder().encode('need review'),
    env: {
      ...process.env,
      ATC_BRIDGE: '1',
      ATC_SOCKET: sock,
      ATC_OUTBOX: outbox,
      ATC_SESSION_ID: 's1',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const code = await proc.exited;

  expect(code).toBe(0);
  expect(readdirSync(outbox)).toHaveLength(1);
});
