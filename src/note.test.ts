import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { runNote } from './note';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { startStubReporterSocket } from './test-utils/start-stub-reporter-socket';
import { startStubSessionBridge } from './test-utils/start-stub-session-bridge';
import { updateEnv } from './test-utils/update-env';

/**
 * A stub of the daemon's reporter socket in a temp directory, for the
 * reporter to send its line to; the reporter must exit 0 on every path.
 * The stub stops, and the directory goes, once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-note-');
  const sock = join(tmp.dir, 'reporter.sock');
  const reporter = startStubReporterSocket(sock);

  return { sock, reporter };
}

test('it forwards an answered envelope with the final text from stdin', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    event: 'Note',
    payload: { kind: 'answered', message: 'm-1', answer: 'all done' },
  });
});

test('it forwards an answered envelope with the turn that carried the message', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    event: 'Note',
    payload: { kind: 'answered', message: 'm-1', answer: 'all done', turn: 't-7' },
  });
});

test('it forwards one answered envelope for every message a turn answered', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    event: 'Note',
    payload: { kind: 'answered', messages: ['m-1', 'm-2'], answer: 'both done', turn: 't-7' },
  });
});

test('it exits 0 when nothing listens at the socket', async () => {
  const tmp = setupTempDir('atc-note-');

  updateEnv('ATC_SOCKET', join(tmp.dir, 'none.sock'));
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

test('it exits 0 for an unknown note kind', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    event: 'Note',
    payload: { kind: 'note', label: 'blocked', text: 'need review' },
  });
});

test('it labels a note progress when no label is given', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    event: 'Note',
    payload: { kind: 'note', label: 'progress', text: 'halfway there' },
  });
});

test('it exits 0 for a note without text', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

test('it clears a bridge note from the outbox once the bridge refuses it as forbidden', async () => {
  const tmp = setupTempDir('atc-note-');
  const sock = join(tmp.dir, 'bridge.sock');
  const outbox = join(tmp.dir, 'outbox');

  mkdirSync(outbox);

  const bridge = startStubSessionBridge(sock, (request) => [
    { id: request['id'], ok: false, code: 'forbidden' },
  ]);

  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', sock);
  updateEnv('ATC_OUTBOX', outbox);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
    'note',
    { message: '', messages: '', label: '', turn: '' },
    {
      readStdin: () => Promise.resolve('need review'),
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  expect(codes).toStrictEqual([0]);
  expect(readdirSync(outbox)).toStrictEqual([]);

  expect(bridge.requests).toStrictEqual([
    {
      v: 1,
      id: expect.toBeString(),
      op: 'note',
      noteID: expect.toBeString(),
      payload: { kind: 'note', label: 'progress', text: 'need review' },
    },
  ]);
});

test('it keeps a bridge note in the outbox when the bridge closes without answering', async () => {
  const tmp = setupTempDir('atc-note-');
  const sock = join(tmp.dir, 'bridge.sock');
  const outbox = join(tmp.dir, 'outbox');

  mkdirSync(outbox);

  const bridge = startStubSessionBridge(sock, () => null);

  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', sock);
  updateEnv('ATC_OUTBOX', outbox);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runNote(
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

  invariant(name !== undefined, 'the note left the outbox');

  const note: unknown = JSON.parse(readFileSync(join(outbox, name), 'utf8'));

  expect(name).toMatch(/^[\da-f-]{36}\.json$/u);
  expect(codes).toStrictEqual([0]);
  expect(others).toStrictEqual([]);

  expect(bridge.requests).toStrictEqual([
    {
      v: 1,
      id: expect.toBeString(),
      op: 'note',
      noteID: name.slice(0, -'.json'.length),
      payload: { kind: 'note', label: 'progress', text: 'need review' },
    },
  ]);

  expect(note).toStrictEqual({
    noteID: name.slice(0, -'.json'.length),
    payload: { kind: 'note', label: 'progress', text: 'need review' },
  });
});
