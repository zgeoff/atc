import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runReport } from './report';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { startStubReporterSocket } from './test-utils/start-stub-reporter-socket';
import { startStubSessionBridge } from './test-utils/start-stub-session-bridge';
import { updateEnv } from './test-utils/update-env';

/**
 * A stub of the daemon's reporter socket in a temp directory, for the
 * reporter to send its line to; the reporter must exit 0 on every path.
 * Disposal stops the stub and removes the directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-report-'));
  const sock = join(tmp.dir, 'reporter.sock');
  const reporter = stack.use(startStubReporterSocket(sock));
  const owned = stack.move();

  return {
    dir: tmp.dir,
    sock,
    reporter,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it forwards an answered report with the final text from stdin', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'answered',
    { message: 'm-1', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('all done'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  const line = await ctx.reporter.waitForLine();

  expect({ codes, line: JSON.parse(line) as unknown }).toStrictEqual({
    codes: [0],
    line: {
      atcId: 's1',
      event: 'Report',
      payload: { kind: 'answered', message: 'm-1', answer: 'all done' },
    },
  });
});

test('it forwards an answered report with the turn that carried the message', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'answered',
    { message: 'm-1', messages: '', label: '', turn: 't-7' },
    {
      readStdin: () => Promise.resolve('all done'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  const line = await ctx.reporter.waitForLine();

  expect({ codes, line: JSON.parse(line) as unknown }).toStrictEqual({
    codes: [0],
    line: {
      atcId: 's1',
      event: 'Report',
      payload: { kind: 'answered', message: 'm-1', answer: 'all done', turn: 't-7' },
    },
  });
});

test('it forwards one answered report for every message a turn answered', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'answered',
    { message: '', messages: 'm-1,m-2', label: '', turn: 't-7' },
    {
      readStdin: () => Promise.resolve('both done'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  const line = await ctx.reporter.waitForLine();

  expect({ codes, line: JSON.parse(line) as unknown }).toStrictEqual({
    codes: [0],
    line: {
      atcId: 's1',
      event: 'Report',
      payload: { kind: 'answered', messages: ['m-1', 'm-2'], answer: 'both done', turn: 't-7' },
    },
  });
});

test('it exits 0 when nothing listens at the socket', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', join(ctx.dir, 'none.sock'));
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'answered',
    { message: 'm-1', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('all done'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  expect(codes).toStrictEqual([0]);
});

test('it exits 0 without a message id', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'answered',
    { message: '', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('all done'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  expect(codes).toStrictEqual([0]);
});

test('it exits 0 for an unknown report kind', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'progress',
    { message: 'm-1', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('all done'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  expect(codes).toStrictEqual([0]);
});

test('it forwards a note with its label and the text from stdin', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'note',
    { message: '', messages: '', label: 'blocked', turn: '' },
    {
      readStdin: () => Promise.resolve('need review'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  const line = await ctx.reporter.waitForLine();

  expect({ codes, line: JSON.parse(line) as unknown }).toStrictEqual({
    codes: [0],
    line: {
      atcId: 's1',
      event: 'Report',
      payload: { kind: 'note', label: 'blocked', text: 'need review' },
    },
  });
});

test('it labels a note progress when no label is given', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'note',
    { message: '', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('halfway there'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  const line = await ctx.reporter.waitForLine();

  expect({ codes, line: JSON.parse(line) as unknown }).toStrictEqual({
    codes: [0],
    line: {
      atcId: 's1',
      event: 'Report',
      payload: { kind: 'note', label: 'progress', text: 'halfway there' },
    },
  });
});

test('it exits 0 for a note without text', async () => {
  using ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'note',
    { message: '', messages: '', label: 'blocked', turn: '' },
    {
      readStdin: () => Promise.resolve('  \n'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  expect(codes).toStrictEqual([0]);
});

test('it clears a bridge report from the outbox once the bridge refuses it as forbidden', async () => {
  using ctx = setupTest();

  const sock = join(ctx.dir, 'bridge.sock');
  const outbox = join(ctx.dir, 'outbox');

  mkdirSync(outbox);

  using bridge = startStubSessionBridge(sock, (request) => [
    { id: request['id'], ok: false, code: 'forbidden' },
  ]);

  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', sock);
  updateEnv('ATC_OUTBOX', outbox);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'note',
    { message: '', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('need review'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  expect({ codes, outbox: readdirSync(outbox), requests: bridge.requests }).toStrictEqual({
    codes: [0],
    outbox: [],
    requests: [
      {
        v: 1,
        id: expect.toBeString(),
        op: 'report',
        reportID: expect.toBeString(),
        payload: { kind: 'note', label: 'progress', text: 'need review' },
      },
    ],
  });
});

test('it keeps a bridge report in the outbox when the bridge closes without answering', async () => {
  using ctx = setupTest();

  const sock = join(ctx.dir, 'bridge.sock');
  const outbox = join(ctx.dir, 'outbox');

  mkdirSync(outbox);

  using bridge = startStubSessionBridge(sock, () => null);

  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', sock);
  updateEnv('ATC_OUTBOX', outbox);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runReport(
    'note',
    { message: '', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('need review'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  const [name, ...others] = readdirSync(outbox);

  if (name === undefined) {
    throw new Error('the report left the outbox');
  }

  const report: unknown = JSON.parse(readFileSync(join(outbox, name), 'utf8'));

  expect(name).toMatch(/^[\da-f-]{36}\.json$/u);

  expect({ codes, others, report, requests: bridge.requests }).toStrictEqual({
    codes: [0],
    others: [],
    requests: [
      {
        v: 1,
        id: expect.toBeString(),
        op: 'report',
        reportID: name.slice(0, -'.json'.length),
        payload: { kind: 'note', label: 'progress', text: 'need review' },
      },
    ],
    report: {
      reportID: name.slice(0, -'.json'.length),
      payload: { kind: 'note', label: 'progress', text: 'need review' },
    },
  });
});
