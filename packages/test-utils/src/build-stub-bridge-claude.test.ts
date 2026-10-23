import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubBridgeClaude } from './build-stub-bridge-claude';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { resolveATCCommand } from './resolve-atc-command';
import { setupTempDir } from './setup-temp-dir';
import { startStubSessionBridge } from './start-stub-session-bridge';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-bridge-claude-');
  const guest = join(temporaryDirectory.path, 'guest');

  const bin = createStubBin(
    temporaryDirectory.path,
    'claude',
    buildStubBridgeClaude(resolveATCCommand(), guest),
  );

  return { directory: temporaryDirectory.path, guest, bin };
}

test('it reports its start and opens a tap through the session bridge', async () => {
  const ctx = setupTest();
  const bridge = startStubSessionBridge(join(ctx.directory, 'bridge.sock'), () => []);

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SESSION_ID: 's-1',
      ATC_BRIDGE: '1',
      ATC_SOCKET: join(ctx.directory, 'bridge.sock'),
      ATC_OUTBOX: join(ctx.directory, 'outbox'),
    },

    // The tap the script starts outlives the script, so each test kills the
    // whole group.
    detached: true,
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  await waitFor(() => {
    expect(bridge.requests).toHaveLength(2);
  });

  expect(bridge.requests).toIncludeSameMembers([
    {
      atcId: 's-1',
      event: 'SessionStart',
      payload: { hook_event_name: 'SessionStart', session_id: 'stub-1' },
    },
    { version: 1, id: 'tap.open', op: 'tap.open', notices: true },
  ]);
});

test('it opens a tap again once the mod files are written', async () => {
  const ctx = setupTest();
  const bridge = startStubSessionBridge(join(ctx.directory, 'bridge.sock'), () => []);

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SESSION_ID: 's-1',
      ATC_BRIDGE: '1',
      ATC_SOCKET: join(ctx.directory, 'bridge.sock'),
      ATC_OUTBOX: join(ctx.directory, 'outbox'),
    },
    detached: true,
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  await waitFor(() => {
    expect(bridge.requests).toPartiallyContain({ op: 'tap.open' });
  });

  mkdirSync(join(ctx.guest, 'sessions', 's-1', 'atc-bridge', 'hooks'), { recursive: true });

  writeFileSync(
    join(ctx.guest, 'sessions', 's-1', 'atc-bridge', 'hooks', 'atc-cli.ts'),
    'export const ATC_CLI = ["atc"];\n',
  );

  await waitFor(() => {
    expect(bridge.requests.filter((request) => request['op'] === 'tap.open')).toHaveLength(2);
  });
});
