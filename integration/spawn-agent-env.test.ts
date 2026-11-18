import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubGuestCLIs } from '@atc/app/test-utils/create-stub-guest-clis';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { parseConfig } from '@atc/config';
import { getRecord } from '@atc/core/test-utils/get-record';
import { readJSONRecord } from '@atc/core/test-utils/read-json-record';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { buildGuestSessionDirectory } from '@atc/daemon';
import { buildMockExecutionTarget } from '@atc/daemon/test-utils/build-mock-execution-target';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/test-utils/create-stub-imp-port';
import { createStubDirProvider } from '@atc/execution-local/test-utils/create-stub-dir-provider';
import { buildGuestSettingsPath } from '@atc/harness-claude';
import { buildMockHostServices } from '@atc/plugin-api/test-utils/build-mock-host-services';
import invariant from 'tiny-invariant';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { createHostServices } from '../packages/app/src/create-host-services';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-agent-env-');
  const clis = createStubGuestCLIs(join(temporaryDirectory.path, 'bin'));
  const port = createStubImpPort();
  const local = createStubDirProvider();
  const guestDir = join(temporaryDirectory.path, 'g');

  const startDaemon = (
    agents: Readonly<Record<string, unknown>>,
    sessionEnv: Readonly<Record<string, string>> = {},
  ) =>
    startTestDaemon({
      prefix: 'atc-agent-env-daemon-',
      options: (paths) => ({
        adapters: buildAgentAdapters(
          parseConfig(SHIPPED_HARNESS_PLUGINS, { agents }),
          buildMockHostServices(),
          null,
          {
            stateDir: join(paths.directory, 'state'),
            homeDir: join(paths.directory, 'home'),
            bridgeTarget: join(paths.directory, 'atc-bridge'),
          },
        ),
        targets: [
          buildMockExecutionTarget({
            id: 'desk',
            kind: local.kind,
            identity: 'test:desk',
            provider: local,
          }),
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: createImpProvider(
              port,
              { guestDir, guestATC: clis.atc, sessionEnv },
              {
                reconnectDelaysMs: [0, 0, 0],
                atcBinary: null,
                version: createHostServices().version,
              },
            ),
          },
        ],
        defaultTarget: 'desk',
      }),
    });

  return { clis, port, local, guestDir, startDaemon };
}

test.each(['codex', 'grok'])("it gives a local %s session the entry's env", async (agent) => {
  const ctx = setupTest();

  const daemon = await ctx.startDaemon({
    [agent]: { bin: ctx.clis.claude, env: { NOTES_VAULT: 'desk/notes-key' } },
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent,
    target: 'desk',
  });

  const [harness] = ctx.local.harnesses;

  expect(harness?.env['NOTES_VAULT']).toBe('desk/notes-key');
});

test("it gives a local Claude session the entry's env and settings env in its settings file", async () => {
  const ctx = setupTest();

  const daemon = await ctx.startDaemon({
    claude: {
      bin: ctx.clis.claude,
      env: { NOTES_VAULT: 'desk/notes-key' },
      settings: { env: { NOTES_REGION: 'eu' } },
    },
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'claude',
    target: 'desk',
  });

  const [harness] = ctx.local.harnesses;
  const flag = harness?.args.indexOf('--settings') ?? -1;
  const settingsPath = harness?.args[flag + 1];

  invariant(flag >= 0 && settingsPath !== undefined, 'the harness took no --settings file');

  const settings = await readJSONRecord(Bun.file(settingsPath));

  expect(getRecord(settings, 'env')).toStrictEqual({
    NOTES_REGION: 'eu',
    NOTES_VAULT: 'desk/notes-key',
  });
});

test.each(['codex', 'grok'])("it gives a remote %s session the entry's env", async (agent) => {
  const ctx = setupTest();

  const daemon = await ctx.startDaemon({
    [agent]: { bin: ctx.clis.claude, env: { NOTES_VAULT: 'desk/notes-key' } },
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent,
    target: 'box',
  });

  const [request] = ctx.port.sessionRequests;

  invariant(request?.kind === 'start', 'expected the harness start request');

  expect(request.env['NOTES_VAULT']).toBe('desk/notes-key');
});

test.each(['codex', 'grok'])(
  "it gives a remote %s session the target's sessionEnv value for a key the entry's env also sets",
  async (agent) => {
    const ctx = setupTest();

    const daemon = await ctx.startDaemon(
      { [agent]: { bin: ctx.clis.claude, env: { NOTES_VAULT: 'desk/notes-key' } } },
      { NOTES_VAULT: 'box/notes-key' },
    );

    await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.directory,
      agent,
      target: 'box',
    });

    const [request] = ctx.port.sessionRequests;

    invariant(request?.kind === 'start', 'expected the harness start request');

    expect(request.env['NOTES_VAULT']).toBe('box/notes-key');
  },
);

test("it gives a remote Claude session the entry's env and settings env in its settings file", async () => {
  const ctx = setupTest();

  const daemon = await ctx.startDaemon({
    claude: {
      bin: ctx.clis.claude,
      env: { NOTES_VAULT: 'desk/notes-key' },
      settings: { env: { NOTES_REGION: 'eu' } },
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'claude',
    target: 'box',
  });

  const directory = buildGuestSessionDirectory(
    ctx.guestDir,
    String(getRecord(spawned, 'session')['id']),
  );

  const settings = await readJSONRecord(Bun.file(buildGuestSettingsPath(directory)));

  expect(getRecord(settings, 'env')).toStrictEqual(
    expect.objectContaining({ NOTES_REGION: 'eu', NOTES_VAULT: 'desk/notes-key' }),
  );
});
