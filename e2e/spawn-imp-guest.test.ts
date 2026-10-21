import { expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { createClaudeAdapter } from '@atc/harness-claude';
import {
  buildMockAgentAdapter,
  buildMockHostServices,
  createStubGuestCLIs,
  getAgentEntry,
  getRecord,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { createHostServices } from '../packages/app/src/create-host-services';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// The fixed parts every imp guest test shares: the stub guest tools and the
// guest folder under a temp directory, and a stub imp port.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-imp-guest-');
  const clis = createStubGuestCLIs(join(temporaryDirectory.path, 'bin'));
  const port = createStubImpPort();

  return { port, guestDir: join(temporaryDirectory.path, 'g'), clis };
}

test('it refuses a remote Claude spawn when the host has no atc and the daemon has none to copy', async () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.clis.claude } },
  });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'imp', agent: 'claude', problem: 'no_guest_atc' },
  });

  expect(ctx.port.collectImpNames()).toBeEmpty();
});

test('it gives a remote Claude session settings, a statusline, and a mod that report through the atc in its host', async () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.clis.claude } },
  });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir, guestATC: ctx.clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
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

  const directory = join(ctx.guestDir, 'sessions', String(getRecord(spawned, 'session')['id']));
  const settings: unknown = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
  const guestATC = join(ctx.guestDir, 'bin', 'atc');

  expect(settings).toMatchObject({
    hooks: {
      SessionStart: [{ hooks: [{ command: `"${guestATC}" hook-report --agent='claude'` }] }],
    },
    statusLine: { command: `"${guestATC}" statusline --agent='claude'` },
  });

  expect(readFileSync(join(directory, 'atc-bridge', 'hooks', 'atc-cli.ts'), 'utf8')).toInclude(
    JSON.stringify([guestATC]),
  );

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({
      argv: [
        'sh',
        '-c',
        expect.any(String),
        'sh',
        join(directory, 'scratch'),
        expect.any(String),
        '--add-dir',
        join(directory, 'scratch'),
        '--settings',
        join(directory, 'settings.json'),
        '--plugin-dir',
        join(directory, 'atc-bridge'),
      ],
    }),
  ]);
});

test("it takes a remote session's hook reports from a socket that serves that session alone", async () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.clis.claude } },
  });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir, guestATC: ctx.clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const first = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const second = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const firstID = String(getRecord(first, 'session')['id']);
  const secondID = String(getRecord(second, 'session')['id']);

  await daemon.client.sendRequest('session.input', {
    session: secondID,
    data: `forge ${firstID}\r`,
  });

  await daemon.client.sendRequest('session.input', { session: secondID, data: 'notify own\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [
        { id: firstID, state: 'running' },
        { id: secondID, state: 'needs_you', lastMsg: 'own' },
      ],
    });
  });
});

test('it keeps a nested harness inside a remote session from rebinding that session', async () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.clis.claude } },
  });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir, guestATC: ctx.clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
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

  await daemon.client.sendRequest('session.input', {
    session: id,
    data: 'start agent-remote-1\r',
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, agentSessionID: 'agent-remote-1' }] });
  });

  await daemon.client.sendRequest('session.input', {
    session: id,
    data: 'nested nested-codex-1\r',
  });

  await daemon.client.sendRequest('session.input', { session: id, data: 'notify own\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [{ id, state: 'needs_you', lastMsg: 'own', agentSessionID: 'agent-remote-1' }],
    });
  });
});

test('it copies its own atc binary into an imp that has none', async () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.clis.claude } },
  });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: ctx.clis.atc,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.directory, cols: 80, rows: 24 });

  const installed = join(ctx.guestDir, 'bin', 'atc');

  expect(readFileSync(installed, 'utf8')).toBe(readFileSync(ctx.clis.atc, 'utf8'));
  expect(statSync(installed).mode & 0o111).toBe(0o111);
});

test('it refuses a remote spawn whose agent is not signed in on the host, before any harness starts', async () => {
  const ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({ bin: ctx.clis.claude, args: [] }),
        planAuthCheck: () => ['false'],
      }),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toMatchObject({
    code: 'auth_not_configured',
    data: { agent: 'claude', target: 'box' },
  });

  expect(ctx.port.sessionRequests).toBeEmpty();
});

test('it destroys the host of its own that a remote spawn readied when its agent is not signed in there', async () => {
  const ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({ bin: ctx.clis.claude, args: [] }),
        planAuthCheck: () => ['false'],
      }),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  await Promise.allSettled([spawned]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawned).rejects.toMatchObject({ code: 'auth_not_configured' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it answers outcome_unknown for a spawn whose agent is not signed in on a host it cannot destroy', async () => {
  const ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({ bin: ctx.clis.claude, args: [] }),
        planAuthCheck: () => ['false'],
      }),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  ctx.port.setDestroyFailure('INTERNAL_SERVER_ERROR');

  expect(
    daemon.client.sendRequest('session.spawn', {
      cwd: daemon.directory,
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a spawn whose agent is not signed in on a host it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  const ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({ bin: ctx.clis.claude, args: [] }),
        planAuthCheck: () => ['false'],
      }),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const params = { cwd: daemon.directory, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  ctx.port.setDestroyFailure('INTERNAL_SERVER_ERROR');

  await Promise.allSettled([daemon.client.sendRequest('session.spawn', params)]);

  const retried = daemon.client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([expect.toStartWith('atc-')]);
});

test('it revives a slept remote session whose transcript only its imp holds', async () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.clis.claude } },
  });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir, guestATC: ctx.clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
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

  await daemon.client.sendRequest('session.input', {
    session: id,
    data: 'start agent-remote-1\r',
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, agentSessionID: 'agent-remote-1' }] });
  });

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, state: 'running', lastMsg: 'revived' }] });
});

test('it refuses a remote Claude spawn when the atc the target names is missing from the host', async () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.clis.claude } },
  });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir, guestATC: ctx.clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  rmSync(ctx.clis.atc);

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'imp', problem: 'no_guest_atc' },
  });

  expect(ctx.port.sessionRequests).toBeEmpty();
});

test('it refuses a remote spawn of an agent that never runs remotely, without blaming a missing atc', async () => {
  const ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  const daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        id: 'zai',
        planSpawn: () => ({ bin: ctx.clis.claude, args: [] }),
        planGuestSpawn: () => null,
      }),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            ctx.port,
            { guestDir: ctx.guestDir, guestATC: ctx.clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: createHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  expect(
    daemon.client.sendRequest('session.spawn', {
      cwd: daemon.directory,
      cols: 80,
      rows: 24,
      agent: 'zai',
    }),
  ).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'imp', agent: 'zai', problem: 'remote_unsupported' },
  });
});
