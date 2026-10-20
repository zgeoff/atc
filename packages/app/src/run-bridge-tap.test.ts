import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir, startStubSessionBridge } from '@atc/test-utils';
import { runBridgeTap } from './run-bridge-tap';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-bridge-tap-');
  const outbox = join(temporaryDirectory.path, 'outbox');

  // The tap reads its notes from here, and each test writes one into it.
  mkdirSync(outbox);

  return {
    directory: temporaryDirectory.path,
    sock: join(temporaryDirectory.path, 'bridge.sock'),
    outbox,
  };
}

test('it removes the outbox file of a note the bridge took', async () => {
  const ctx = setupTest();

  const bridge = startStubSessionBridge(ctx.sock, (request) => [
    { id: request['id'], ok: true },
    { ev: 'InboxClosed' },
  ]);

  writeFileSync(
    join(ctx.outbox, 'r1.json'),
    JSON.stringify({ noteID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  const codes: number[] = [];

  await runBridgeTap(ctx.sock, ctx.outbox, {
    writeStdout: () => Promise.resolve(),
    printError: () => {},
    exit: (code) => {
      codes.push(code);
    },
  });

  expect(codes).toStrictEqual([0]);
  expect(existsSync(join(ctx.outbox, 'r1.json'))).toBe(false);

  expect(bridge.requests).toStrictEqual([
    { v: 1, id: 'tap.open', op: 'tap.open' },
    {
      v: 1,
      id: 'note:r1',
      op: 'note',
      noteID: 'r1',
      payload: { kind: 'note', label: 'progress', text: 'hi' },
    },
  ]);
});

test('it removes no file for an answer to a note id it never sent', async () => {
  const ctx = setupTest();

  const bridge = startStubSessionBridge(ctx.sock, () => [
    { id: 'note:../victim', ok: true },
    { ev: 'InboxClosed' },
  ]);

  writeFileSync(join(ctx.directory, 'victim.json'), '{}');

  writeFileSync(
    join(ctx.outbox, 'r1.json'),
    JSON.stringify({ noteID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  const codes: number[] = [];

  await runBridgeTap(ctx.sock, ctx.outbox, {
    writeStdout: () => Promise.resolve(),
    printError: () => {},
    exit: (code) => {
      codes.push(code);
    },
  });

  expect(codes).toStrictEqual([0]);
  expect(existsSync(join(ctx.directory, 'victim.json'))).toBe(true);
  expect(existsSync(join(ctx.outbox, 'r1.json'))).toBe(true);

  expect(bridge.requests).toStrictEqual([
    { v: 1, id: 'tap.open', op: 'tap.open' },
    {
      v: 1,
      id: 'note:r1',
      op: 'note',
      noteID: 'r1',
      payload: { kind: 'note', label: 'progress', text: 'hi' },
    },
  ]);
});

test('it prints and acks an answer notice when the tap takes notices', async () => {
  const ctx = setupTest();

  // The bridge sends the notice once it answers the note the tap sends,
  // and closes the inbox once the tap acks the notice.
  const bridge = startStubSessionBridge(ctx.sock, (request) =>
    request['op'] === 'note'
      ? [
          { id: request['id'], ok: true },
          {
            v: 4,
            ev: 'InboxNotice',
            s: 's1',
            message: 'm-1',
            from: 's2',
            status: 'answered',
            answer: 'the deploy finished',
            at: 5,
          },
        ]
      : [{ id: request['id'], ok: true }, { ev: 'InboxClosed' }],
  );

  writeFileSync(
    join(ctx.outbox, 'r1.json'),
    JSON.stringify({ noteID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  const printed: string[] = [];

  await runBridgeTap(
    ctx.sock,
    ctx.outbox,
    {
      writeStdout: (text) => {
        printed.push(text);

        return Promise.resolve();
      },
      printError: () => {},
      exit: () => {},
    },
    true,
  );

  expect(printed.map((line): unknown => JSON.parse(line))).toStrictEqual([
    { kind: 'answer', id: 'm-1', from: 's2', status: 'answered', answer: 'the deploy finished' },
  ]);

  expect(bridge.requests).toStrictEqual([
    { v: 1, id: 'tap.open', op: 'tap.open', notices: true },
    {
      v: 1,
      id: 'note:r1',
      op: 'note',
      noteID: 'r1',
      payload: { kind: 'note', label: 'progress', text: 'hi' },
    },
    { v: 1, id: 'notice-ack:m-1', op: 'tap.notice-ack', message: 'm-1' },
  ]);
});

test('it prints no answer notice when the tap takes none', async () => {
  const ctx = setupTest();

  const bridge = startStubSessionBridge(ctx.sock, (request) => [
    { id: request['id'], ok: true },
    {
      v: 4,
      ev: 'InboxNotice',
      s: 's1',
      message: 'm-1',
      from: 's2',
      status: 'unanswered',
      reason: 'interrupted',
      at: 5,
    },
    { ev: 'InboxClosed' },
  ]);

  writeFileSync(
    join(ctx.outbox, 'r1.json'),
    JSON.stringify({ noteID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  const printed: string[] = [];

  await runBridgeTap(ctx.sock, ctx.outbox, {
    writeStdout: (text) => {
      printed.push(text);

      return Promise.resolve();
    },
    printError: () => {},
    exit: () => {},
  });

  expect(printed).toStrictEqual([]);
  expect(bridge.requests.map((request) => request['op'])).toStrictEqual(['tap.open', 'note']);
});

test('it prints a message with the sender the daemon gave it', async () => {
  const ctx = setupTest();

  // The bridge sends the message once it answers the note the tap sends,
  // and closes the inbox once the tap acks the message.
  startStubSessionBridge(ctx.sock, (request) =>
    request['op'] === 'note'
      ? [
          { id: request['id'], ok: true },
          {
            v: 4,
            ev: 'InboxMessage',
            s: 's1',
            message: 'm-1',
            from: 'harbor-refactor',
            sender: { kind: 'session', session: 's2', name: 'harbor-refactor' },
            text: 'rebase onto main',
            sentAt: 5,
          },
        ]
      : [{ id: request['id'], ok: true }, { ev: 'InboxClosed' }],
  );

  writeFileSync(
    join(ctx.outbox, 'r1.json'),
    JSON.stringify({ noteID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  const printed: string[] = [];

  await runBridgeTap(ctx.sock, ctx.outbox, {
    writeStdout: (text) => {
      printed.push(text);

      return Promise.resolve();
    },
    printError: () => {},
    exit: () => {},
  });

  expect(printed.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      id: 'm-1',
      from: 'harbor-refactor',
      sender: { kind: 'session', session: 's2', name: 'harbor-refactor' },
      text: 'rebase onto main',
      sentAt: 5,
    },
  ]);
});
