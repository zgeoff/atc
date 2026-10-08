import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBridgeTap } from './run-bridge-tap';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { startStubSessionBridge } from './test-utils/start-stub-session-bridge';

/**
 * A temp directory for a tap inside a remote host: the socket path where a
 * test starts its stand-in session bridge, and the outbox the tap sends its
 * reports from. The directory goes once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-bridge-tap-');
  const outbox = join(tmp.dir, 'outbox');

  // The tap reads its reports from here, and each test writes one into it.
  mkdirSync(outbox);

  return {
    dir: tmp.dir,
    sock: join(tmp.dir, 'bridge.sock'),
    outbox,
  };
}

test('it removes the outbox file of a report the bridge took', async () => {
  const ctx = setupTest();

  const bridge = startStubSessionBridge(ctx.sock, (request) => [
    { id: request['id'], ok: true },
    { ev: 'InboxClosed' },
  ]);

  writeFileSync(
    join(ctx.outbox, 'r1.json'),
    JSON.stringify({ reportID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
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
      id: 'report:r1',
      op: 'report',
      reportID: 'r1',
      payload: { kind: 'note', label: 'progress', text: 'hi' },
    },
  ]);
});

test('it removes no file for an answer to a report id it never sent', async () => {
  const ctx = setupTest();

  const bridge = startStubSessionBridge(ctx.sock, () => [
    { id: 'report:../victim', ok: true },
    { ev: 'InboxClosed' },
  ]);

  writeFileSync(join(ctx.dir, 'victim.json'), '{}');

  writeFileSync(
    join(ctx.outbox, 'r1.json'),
    JSON.stringify({ reportID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
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
  expect(existsSync(join(ctx.dir, 'victim.json'))).toBe(true);
  expect(existsSync(join(ctx.outbox, 'r1.json'))).toBe(true);

  expect(bridge.requests).toStrictEqual([
    { v: 1, id: 'tap.open', op: 'tap.open' },
    {
      v: 1,
      id: 'report:r1',
      op: 'report',
      reportID: 'r1',
      payload: { kind: 'note', label: 'progress', text: 'hi' },
    },
  ]);
});
