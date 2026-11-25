import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubComposer } from '@atc/app/test-utils/create-stub-composer';
import { getRecords } from '@atc/core/test-utils/get-records';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { createStubClaude } from '@atc/harness-claude/test-utils/create-stub-claude';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';
import { waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-e2e-reload-');
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

test('it lists an agent that the config gains once SIGHUP reaches the daemon', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const before = await client.sendRequest('agents.list');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, zai: { kind: 'claude', bin: ctx.claude } },
    }),
  );

  daemon.subprocess.kill('SIGHUP');

  await waitFor(async () => {
    const listed = await client.sendRequest('agents.list');

    expect(getRecords(listed, 'agents').map((agent) => agent['id'])).toStrictEqual([
      'claude',
      'zai',
    ]);

    expect(listed['configRevision']).not.toBe(before['configRevision']);
  });
});

test('it keeps the agents and names the cause when SIGHUP finds a file that is not JSON', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const before = await client.sendRequest('agents.list');

  writeFileSync(ctx.configPath, '{ "agents": ');

  daemon.subprocess.kill('SIGHUP');

  await waitFor(() => {
    expect(daemon.readStderr()).toInclude(
      `atc daemon: config reload failed (${ctx.configPath} cannot be used: config_malformed, the file is not valid JSON); the daemon keeps its old config`,
    );
  });

  const after = await client.sendRequest('agents.list');

  expect(after).toStrictEqual(before);
});

test('it keeps the default target and prints the problem when SIGHUP finds a default that names no target', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const before = await client.sendRequest('agents.list');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
      targets: { local: { provider: 'local-pty' } },
      defaultTarget: 'ghost',
    }),
  );

  daemon.subprocess.kill('SIGHUP');

  await waitFor(() => {
    expect(daemon.readStderr()).toInclude(
      'atc daemon: config: defaultTarget: matches no well-formed target in targets',
    );
  });

  const after = await client.sendRequest('agents.list');

  expect(after['spawnDefaults']).toStrictEqual(before['spawnDefaults']);
});
