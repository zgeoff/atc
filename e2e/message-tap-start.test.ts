import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { createStubRelayProvider } from '@atc/execution-local/testing';
import {
  buildMockAgentAdapter,
  buildStubBridgeClaude,
  buildStubClock,
  createStubBin,
  getRecord,
  resolveATCCommand,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it delivers a message to a top-level remote session whose agent started a tap the relay dropped', async () => {
  const host = setupTempDir('atc-tap-start-');
  const guest = join(host.path, 'guest');
  const clock = buildStubClock(0);
  const provider = createStubRelayProvider({ directory: host.path, droppedTapOpens: 1 });

  onTestFinished(() => {
    provider.stop();
  });

  const claude = createStubBin(
    host.path,
    'claude',
    buildStubBridgeClaude(resolveATCCommand(), guest),
  );

  const daemon = await startTestDaemon({
    prefix: 'atc-tap-start-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planSpawn: () => ({ bin: claude, args: [] }),
        planHookEvents: () => ({ events: [{ kind: 'started' }] }),
        planGuestBridgeFiles: (atc) => ({
          'atc-bridge/hooks/atc-cli.ts': `export const ATC_CLI = ["${atc}"];\n`,
        }),
      }),
      targets: [
        {
          id: 'box',
          kind: provider.kind,
          options: {},
          identity: 'test:box',
          provider: {
            ...provider,
            readGuest: () => Promise.resolve({ directory: guest, atc: '/opt/atc/bin/atc' }),
          },
        },
      ],
      defaultTarget: 'box',
      clock,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await waitFor(() => {
    expect(provider.countDroppedTapOpens()).toBe(1);
    expect(clock.collectPending()).toContain(30_000);
  });

  clock.advance(30_000);

  const sent = await waitFor(() =>
    daemon.client.sendRequest('session.message', { session: id, text: 'is the harbour open?' }),
  );

  const message = String(sent['message']);

  await waitFor(async () => {
    const view = await daemon.client.sendRequest('message.get', { message });

    expect(view).toMatchObject({ status: 'delivered' });
  });

  expect(sent).toStrictEqual({ message: expect.toStartWith('m-'), status: 'queued' });
});
