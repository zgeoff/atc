import { expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { getAgentEntry } from '../../test/get-agent-entry';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';
import type { ImpTargetOptions } from './imp-provider';

// The atc CLI from this source tree, which a fake guest atc runs.
const CLI_PATH = join(import.meta.dir, '..', 'cli.ts');

// A real daemon whose one target `box` runs on the imp provider over a
// fixture imp port, with the guest folder under a temp directory. The
// adapter is Claude's own, whose binary is a fake claude that prints its
// pid and, on `start`, reports a SessionStart with a transcript only the
// imp holds; on `notify`, a Notification through the guest atc; on
// `forge <id>`, a Notification as the session `<id>` instead.
async function setupTest(
  options: Readonly<{
    guestATC?: boolean;
    atcBinary?: boolean;
    adapter?: (fakeClaude: string) => AgentAdapter;
  }> = {},
) {
  const tmp = setupTempDir('atc-imp-guest-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const fakeClaude = join(tmp.dir, 'fake-claude');
  const fakeATC = join(tmp.dir, 'fake-atc');
  const guestDir = join(tmp.dir, 'g');

  const port = new FixtureImpPort();

  writeFileSync(fakeATC, `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`, {
    mode: 0o755,
  });

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "UP:$$"
while read -r line; do
  case "$line" in
    start) echo '{"hook_event_name":"SessionStart","session_id":"agent-remote-1","transcript_path":"/guest/only/transcript.jsonl"}' | "${fakeATC}" hook-report --agent claude ;;
    notify) echo '{"hook_event_name":"Notification","message":"own"}' | "${fakeATC}" hook-report --agent claude ;;
    nested) echo '{"hook_event_name":"SessionStart","session_id":"nested-codex-1","source":"startup"}' | "${fakeATC}" hook-report --agent codex ;;
    forge*) echo '{"hook_event_name":"Notification","message":"forged"}' | ATC_SESSION_ID="\${line#forge }" "${fakeATC}" hook-report --agent claude ;;
  esac
  echo "GOT:$line"
done
`,
    { mode: 0o755 },
  );

  const target: ImpTargetOptions = {
    guestDir,
    ...(options.guestATC === true ? { guestATC: fakeATC } : {}),
  };

  const adapterConfig = parseConfig({ claudeBin: fakeClaude });

  const adapter =
    options.adapter?.(fakeClaude) ??
    new ClaudeAdapter(getAgentEntry(adapterConfig, 'claude'), adapterConfig);

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter,
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: [
      {
        id: 'box',
        kind: 'imp',
        options: {},
        identity: 'imp:test',
        provider: new ImpProvider(port, target, {
          reconnectDelaysMs: [0, 0, 0],
          atcBinary: options.atcBinary === true ? fakeATC : null,
        }),
      },
    ],
    defaultTarget: 'box',
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    dir: tmp.dir,
    guestDir,
    fakeATC,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it refuses a remote Claude spawn when the host has no atc and the daemon has none to copy', async () => {
  await using daemon = await setupTest();

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'imp', agent: 'claude', problem: 'no_guest_atc' },
  });

  await spawned.catch(() => null);

  expect(daemon.port.collectImpNames()).toBeEmpty();
});

test('it gives a remote Claude session settings, a statusline, and a mod that report through the atc in its host', async () => {
  await using daemon = await setupTest({ guestATC: true });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const dir = join(daemon.guestDir, 'sessions', String(getRecord(spawned, 'session')['id']));
  const settings: unknown = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

  expect(settings).toMatchObject({
    hooks: {
      SessionStart: [{ hooks: [{ command: `"${daemon.fakeATC}" hook-report --agent 'claude'` }] }],
    },
    statusLine: { command: `"${daemon.fakeATC}" statusline --agent 'claude'` },
  });

  expect(readFileSync(join(dir, 'atc-bridge', 'hooks', 'atc-cli.ts'), 'utf8')).toInclude(
    JSON.stringify([daemon.fakeATC]),
  );

  expect(daemon.port.sessionRequests[0]).toMatchObject({
    argv: [
      expect.any(String),
      '--settings',
      join(dir, 'settings.json'),
      '--plugin-dir',
      join(dir, 'atc-bridge'),
    ],
  });
});

test("it takes a remote session's hook reports from a socket that serves that session alone", async () => {
  await using daemon = await setupTest({ guestATC: true });

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

  await daemon.client.sendRequest('session.input', { session: secondID, d: `forge ${firstID}\r` });
  await daemon.client.sendRequest('session.input', { session: secondID, d: 'notify\r' });

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
  await using daemon = await setupTest({ guestATC: true });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.input', { session: id, d: 'start\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, agentSessionID: 'agent-remote-1' }] });
  });

  await daemon.client.sendRequest('session.input', { session: id, d: 'nested\r' });
  await daemon.client.sendRequest('session.input', { session: id, d: 'notify\r' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [{ id, state: 'needs_you', lastMsg: 'own', agentSessionID: 'agent-remote-1' }],
    });
  });
});

test('it copies its own atc binary into an imp that has none', async () => {
  await using daemon = await setupTest({ atcBinary: true });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, cols: 80, rows: 24 });

  const installed = join(daemon.guestDir, 'bin', 'atc');

  expect(readFileSync(installed, 'utf8')).toBe(readFileSync(daemon.fakeATC, 'utf8'));
  expect(statSync(installed).mode & 0o111).toBe(0o111);
});

test('it refuses a remote spawn whose agent is not signed in on the host, before any harness starts', async () => {
  await using daemon = await setupTest({
    adapter: (fakeClaude) => ({
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: fakeClaude, args: [] }),
      planAuthCheck: () => ['false'],
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
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

  await spawned.catch(() => null);

  expect(daemon.port.sessionRequests).toBeEmpty();
});

test('it destroys the host of its own that a remote spawn readied when its agent is not signed in there', async () => {
  await using daemon = await setupTest({
    adapter: (fakeClaude) => ({
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: fakeClaude, args: [] }),
      planAuthCheck: () => ['false'],
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toMatchObject({ code: 'auth_not_configured' });

  await spawned.catch(() => null);

  expect<Record<string, unknown>>({
    created: daemon.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: daemon.port.collectImpNames(),
    listed: await daemon.client.sendRequest('session.list'),
  }).toStrictEqual({
    created: [expect.toStartWith('imps.create ')],
    imps: [],
    listed: { sessions: [] },
  });
});

test('it keeps the key of a spawn whose agent is not signed in on a host it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  await using daemon = await setupTest({
    adapter: (fakeClaude) => ({
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: fakeClaude, args: [] }),
      planAuthCheck: () => ['false'],
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    }),
  });

  daemon.port.setDestroyFailure('INTERNAL');

  const params = { cwd: daemon.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };
  const first = daemon.client.sendRequest('session.spawn', params);

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await first.catch(() => null);

  const retried = daemon.client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await retried.catch(() => null);

  expect<Record<string, unknown>>({
    created: daemon.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: daemon.port.collectImpNames(),
  }).toStrictEqual({
    created: [expect.toStartWith('imps.create ')],
    imps: [expect.toStartWith('atc-')],
  });
});

test('it revives a slept remote session whose transcript only its imp holds', async () => {
  await using daemon = await setupTest({ guestATC: true });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.input', { session: id, d: 'start\r' });

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
  await using daemon = await setupTest({ guestATC: true });

  rmSync(daemon.fakeATC);

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  expect(spawned).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'imp', problem: 'no_guest_atc' },
  });

  await spawned.catch(() => null);

  expect(daemon.port.sessionRequests).toBeEmpty();
});

test('it refuses a remote spawn of an agent that never runs remotely, without blaming a missing atc', async () => {
  await using daemon = await setupTest({
    guestATC: true,
    adapter: (fakeClaude) => ({
      id: 'zai',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: fakeClaude, args: [] }),
      planGuestSpawn: () => null,
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    }),
  });

  const spawned = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
    agent: 'zai',
  });

  expect(spawned).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'imp', agent: 'zai', problem: 'remote_unsupported' },
  });

  await spawned.catch(() => null);
});
