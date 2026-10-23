import { expect, onTestFinished, test } from 'bun:test';
import type { HarnessRelay } from '@atc/plugin-api';
import { openBridgeSocket } from '@atc/protocol/session';
import { setupTempDir, waitFor } from '@atc/test-utils';
import { createStubRelayProvider } from './create-stub-relay-provider';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-relay-');

  return { directory: temporaryDirectory.path };
}

test('it relays a guest line to the harness and writes the answer back', async () => {
  const ctx = setupTest();
  const provider = createStubRelayProvider({ directory: ctx.directory });

  onTestFinished(() => {
    provider.stop();
  });

  const relays: HarnessRelay[] = [];
  const lines: string[] = [];
  const answers: Readonly<Record<string, unknown>>[] = [];

  const pty = provider.spawnHarness({
    session: 's-relay',
    host: 's-relay',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.directory,
    env: {},
    cols: 80,
    rows: 24,
    onRelay: (relay) => {
      relays.push(relay);

      relay.onLine((line) => {
        lines.push(line);
        void relay.writeLine('{"ok":true}');
      });
    },
  });

  onTestFinished(() => {
    pty.kill();
  });

  const socket = await openBridgeSocket(provider.buildGuestSocketPath('s-relay'), (line) => {
    answers.push(line);
  });

  onTestFinished(() => {
    socket.end();
  });

  socket.writeLine({ op: 'tap.open' });

  await waitFor(() => {
    expect(answers).toStrictEqual([{ ok: true }]);
  });

  expect(lines).toStrictEqual(['{"op":"tap.open"}']);
  expect(relays).toHaveLength(1);
});

test('it takes the first connections it drops without passing them to the harness', async () => {
  const ctx = setupTest();
  const provider = createStubRelayProvider({ directory: ctx.directory, droppedConnections: 1 });

  onTestFinished(() => {
    provider.stop();
  });

  const lines: string[] = [];

  const pty = provider.spawnHarness({
    session: 's-relay',
    host: 's-relay',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.directory,
    env: {},
    cols: 80,
    rows: 24,
    onRelay: (relay) => {
      relay.onLine((line) => {
        lines.push(line);
      });
    },
  });

  onTestFinished(() => {
    pty.kill();
  });

  const path = provider.buildGuestSocketPath('s-relay');

  const dropped = await openBridgeSocket(path, () => {});

  onTestFinished(() => {
    dropped.end();
  });

  dropped.writeLine({ op: 'tap.open', id: 'first' });

  const relayed = await openBridgeSocket(path, () => {});

  onTestFinished(() => {
    relayed.end();
  });

  relayed.writeLine({ op: 'tap.open', id: 'second' });

  await waitFor(() => {
    expect(lines).toStrictEqual(['{"op":"tap.open","id":"second"}']);
  });

  expect(provider.countConnections()).toBe(2);
});
