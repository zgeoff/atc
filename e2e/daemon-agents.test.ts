import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubComposer } from '@atc/app/test-utils/create-stub-composer';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getString } from '@atc/core/test-utils/get-string';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { createStubClaude } from '@atc/harness-claude/test-utils/create-stub-claude';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';
import { waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';

// The atc-bridge mod folder is written by the daemon command from the build
// it runs as, so these cases start the real command.
function setupTest() {
  const temporaryDirectory = createTempDir('atc-e2e-agents-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(temporaryDirectory.path);
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, { atc, composer }),
  };
}

test('it starts a Claude session with the atc-bridge mod folder', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const bridgeDir = join(daemon.stateDir, 'atc-bridge');

  // Wide enough that the echoed args line never wraps mid-path.
  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 600, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude(`--plugin-dir ${bridgeDir}`);

  expect(readFileSync(join(bridgeDir, '.claude-plugin', 'plugin.json'), 'utf8')).toInclude(
    '"name": "atc-bridge"',
  );

  expect(readFileSync(join(bridgeDir, 'hooks', 'atc-cli.ts'), 'utf8')).toIncludeMultiple(ctx.atc);
});

test('it starts a gateway session with the atc-bridge mod folder', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 600,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude(`--plugin-dir ${join(daemon.stateDir, 'atc-bridge')}`);
});
