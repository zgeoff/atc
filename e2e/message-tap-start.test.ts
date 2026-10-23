import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { createStubRelayProvider } from '@atc/execution-local/testing';
import { runBridgeTap } from '@atc/reporters/tap';
import {
  buildMockAgentAdapter,
  buildStubClock,
  getRecord,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it delivers a message to a top-level remote session whose tap opens again after the relay drops its first open', async () => {
  const guest = setupTempDir('atc-tap-start-');
  const provider = createStubRelayProvider({ directory: guest.path, droppedConnections: 1 });

  onTestFinished(() => {
    provider.stop();
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-tap-start-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter({ takesMessages: true }),
      targets: [
        {
          id: 'box',
          kind: provider.kind,
          options: {},
          identity: 'test:box',
          provider: {
            ...provider,
            readGuest: () =>
              Promise.resolve({
                directory: join(paths.directory, 'guest'),
                atc: '/opt/atc/bin/atc',
              }),
          },
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const tapClock = buildStubClock(0);
  const printed: string[] = [];

  void runBridgeTap(
    provider.buildGuestSocketPath(id),
    join(guest.path, 'outbox'),
    {
      writeStdout: (text) => {
        printed.push(text);

        return Promise.resolve();
      },
      printError: () => {},
      exit: () => {},
    },
    false,
    tapClock,
  );

  await waitFor(() => {
    expect(provider.countConnections()).toBe(1);
    expect(tapClock.collectPending()).toStrictEqual([10_000]);
  });

  tapClock.advance(10_000);

  await waitFor(() => {
    expect(tapClock.collectPending()).toStrictEqual([250]);
  });

  tapClock.advance(250);

  await waitFor(() => {
    expect(provider.countConnections()).toBe(2);
    expect(tapClock.collectPending()).toStrictEqual([10_000]);
  });

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'is the harbour open?',
  });

  await waitFor(() => {
    expect(printed).toHaveLength(1);
  });

  expect(sent).toStrictEqual({ message: expect.toStartWith('m-'), status: 'queued' });

  expect(printed.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      id: expect.toStartWith('m-'),
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      text: 'is the harbour open?',
      sentAt: expect.any(Number),
    },
  ]);
});
