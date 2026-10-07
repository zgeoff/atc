import { expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubImpPort } from '../test-utils/build-stub-imp-port';
import { createStubGuestCLIs } from '../test-utils/create-stub-guest-clis';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';

// The fixed parts every imp guest test shares: the stub guest tools and the
// guest folder under a temp directory, and a stub imp port.
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-imp-guest-'));
  const clis = createStubGuestCLIs(join(tmp.dir, 'bin'));
  const port = stack.use(buildStubImpPort());
  const owned = stack.move();

  return {
    port,
    guestDir: join(tmp.dir, 'g'),
    clis,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it refuses a remote Claude spawn when the host has no atc and the daemon has none to copy', async () => {
  using ctx = setupTest();

  const config = parseConfig({ claudeBin: ctx.clis.claude });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
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
  using ctx = setupTest();

  const config = parseConfig({ claudeBin: ctx.clis.claude });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const dir = join(ctx.guestDir, 'sessions', String(getRecord(spawned, 'session')['id']));
  const settings: unknown = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

  expect(settings).toMatchObject({
    hooks: {
      SessionStart: [{ hooks: [{ command: `"${ctx.clis.atc}" hook-report --agent 'claude'` }] }],
    },
    statusLine: { command: `"${ctx.clis.atc}" statusline --agent 'claude'` },
  });

  expect(readFileSync(join(dir, 'atc-bridge', 'hooks', 'atc-cli.ts'), 'utf8')).toInclude(
    JSON.stringify([ctx.clis.atc]),
  );

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({
      argv: [
        expect.any(String),
        '--settings',
        join(dir, 'settings.json'),
        '--plugin-dir',
        join(dir, 'atc-bridge'),
      ],
    }),
  ]);
});

test("it takes a remote session's hook reports from a socket that serves that session alone", async () => {
  using ctx = setupTest();

  const config = parseConfig({ claudeBin: ctx.clis.claude });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const first = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const second = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const firstID = String(getRecord(first, 'session')['id']);
  const secondID = String(getRecord(second, 'session')['id']);

  await daemon.client.sendRequest('session.input', {
    session: secondID,
    d: `forge ${firstID}\r`,
  });

  await daemon.client.sendRequest('session.input', { session: secondID, d: 'notify own\r' });

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
  using ctx = setupTest();

  const config = parseConfig({ claudeBin: ctx.clis.claude });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.input', {
    session: id,
    d: 'start agent-remote-1\r',
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, agentSessionID: 'agent-remote-1' }] });
  });

  await daemon.client.sendRequest('session.input', {
    session: id,
    d: 'nested nested-codex-1\r',
  });

  await daemon.client.sendRequest('session.input', { session: id, d: 'notify own\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [{ id, state: 'needs_you', lastMsg: 'own', agentSessionID: 'agent-remote-1' }],
    });
  });
});

test('it copies its own atc binary into an imp that has none', async () => {
  using ctx = setupTest();

  const config = parseConfig({ claudeBin: ctx.clis.claude });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, cols: 80, rows: 24 });

  const installed = join(ctx.guestDir, 'bin', 'atc');

  expect(readFileSync(installed, 'utf8')).toBe(readFileSync(ctx.clis.atc, 'utf8'));
  expect(statSync(installed).mode & 0o111).toBe(0o111);
});

test('it refuses a remote spawn whose agent is not signed in on the host, before any harness starts', async () => {
  using ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
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
  using ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  await Promise.allSettled([spawned]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawned).rejects.toMatchObject({ code: 'auth_not_configured' });

  expect<Record<string, unknown>>({
    created: ctx.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: ctx.port.collectImpNames(),
    listed,
  }).toStrictEqual({
    created: [expect.toStartWith('imps.create ')],
    imps: [],
    listed: { sessions: [] },
  });
});

test('it answers outcome_unknown for a spawn whose agent is not signed in on a host it cannot destroy', async () => {
  using ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  ctx.port.setDestroyFailure('INTERNAL');

  expect(
    daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a spawn whose agent is not signed in on a host it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  using ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const params = { cwd: daemon.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  ctx.port.setDestroyFailure('INTERNAL');

  await Promise.allSettled([daemon.client.sendRequest('session.spawn', params)]);

  const retried = daemon.client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect<Record<string, unknown>>({
    created: ctx.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: ctx.port.collectImpNames(),
  }).toStrictEqual({
    created: [expect.toStartWith('imps.create ')],
    imps: [expect.toStartWith('atc-')],
  });
});

test('it revives a slept remote session whose transcript only its imp holds', async () => {
  using ctx = setupTest();

  const config = parseConfig({ claudeBin: ctx.clis.claude });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.input', {
    session: id,
    d: 'start agent-remote-1\r',
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
  using ctx = setupTest();

  const config = parseConfig({ claudeBin: ctx.clis.claude });

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
    prefix: 'atc-imp-guest-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  rmSync(ctx.clis.atc);

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
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
  using ctx = setupTest();

  // A real daemon whose one target `box`, its default, runs on the imp
  // provider over the stub imp port.
  await using daemon = await startTestDaemon({
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
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  expect(
    daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      cols: 80,
      rows: 24,
      agent: 'zai',
    }),
  ).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'imp', agent: 'zai', problem: 'remote_unsupported' },
  });
});
