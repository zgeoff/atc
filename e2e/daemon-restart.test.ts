import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { findDaemonRecord } from '../src/shared/find-daemon-record';
import { isRecord } from '../src/shared/report';
import { toAgentID } from '../src/shared/to-agent-id';
import { toSessionID } from '../src/shared/to-session-id';
import { StateStore } from '../src/store/state-store';
import { buildMockFleetEntry } from '../src/test-utils/build-mock-fleet-entry';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubSystemd } from '../src/test-utils/create-stub-systemd';
import { getRecords } from '../src/test-utils/get-records';
import { getString } from '../src/test-utils/get-string';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A home with a stub Claude CLI and an empty config directory, and a fake
 * systemd that `path` finds first, for the `atc daemon` that each test
 * starts with that PATH once it has written its config. Every atc command
 * the test runs gets the same PATH.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-restart-');
  const atc = resolveATCCommand();
  const fake = createStubSystemd(atc);
  const configDir = join(tmp.dir, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: tmp.dir,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(tmp.dir, { atc, composer: createStubComposer(tmp.dir) }),
    fake,
    path: `${fake.binDir}:/usr/sbin:/usr/bin:/bin`,
  };
}

test('it restarts the daemon in place and restores a saved fleet of two live sessions', async () => {
  const ctx = setupTest();

  // Each stub reports its own atc session as its agent session, so every
  // session a restart restores comes back under its own row.
  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();
  const hello = await client.sendHello('atc/test');

  const oldPID = daemon.proc.pid;

  const seed = await StateStore.open(join(daemon.stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-one'), cwd: ctx.home }),
    buildMockFleetEntry({ sessionID: toSessionID('s-two'), cwd: ctx.home }),
  ]);

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(
    async () => {
      const listed = await client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ alive: true }, { alive: true }] });
    },
    { timeoutMs: 20_000 },
  );

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const replacement = await daemon.openClient();

  await replacement.sendHello('atc/test');

  const listed = await waitFor(
    async () => {
      const read = await replacement.sendRequest('session.list');

      expect(read).toMatchObject({ sessions: [{ alive: true }, { alive: true }] });

      return read;
    },
    { timeoutMs: 20_000 },
  );

  const build = getString(hello, 'daemon');
  const record = findDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);
  expect(record.pid).not.toBe(oldPID);
  expect(() => process.kill(oldPID, 0)).toThrow();

  expect(getRecords(listed, 'sessions').map((s) => s['id'])).toIncludeSameMembers([
    's-one',
    's-two',
  ]);

  expect(restart.stdout).toInclude(`daemon: pid ${oldPID}, build ${build}`);
  expect(restart.stdout).toInclude(`replacement: build ${build}`);
  expect(restart.stdout).toInclude('the interrupted turn does not continue');
  expect(restart.stdout).toInclude('restored 2 of 2');

  expect(ctx.fake.readSystemctlCalls().filter((call) => call.includes('restart'))).toStrictEqual(
    [],
  );
}, 60_000);

test('it exits 1 and names a row whose agent is gone while the good row comes back alive', async () => {
  const ctx = setupTest();

  // Each stub reports its own atc session as its agent session, so every
  // session a restart restores comes back under its own row.
  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const seed = await StateStore.open(join(daemon.stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-good'), name: 'good', cwd: ctx.home }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-dropped'),
      name: 'dropped',
      cwd: ctx.home,
      agent: toAgentID('dropped-backend'),
    }),
  ]);

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart', '--timeout', '3'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const replacement = await daemon.openClient();

  await replacement.sendHello('atc/test');

  const listed = await replacement.sendRequest('session.list');

  expect(restart.exitCode).toBe(1);

  expect(
    getRecords(listed, 'sessions')
      .filter((session) => session['kind'] === 'pty')
      .map((session) => session['id']),
  ).toStrictEqual(['s-good']);

  expect(restart.stdout).toInclude(
    'failed: dropped (s-dropped): listed in state running without a terminal: no adapter for',
  );

  expect(restart.stdout).toInclude('restored 1 of 2');
}, 60_000);

test('it leaves the daemon running when the token file for the replacement cannot be read', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const oldPID = daemon.proc.pid;

  const restart = await runATC({
    command: ctx.atc,
    args: [
      'daemon',
      'restart',
      '--listen',
      '127.0.0.1:0',
      '--token-file',
      join(ctx.home, 'missing-tokens'),
    ],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  expect(restart.exitCode).toBe(1);
  expect(restart.stdout).toInclude('the daemon was left running');
  expect(findDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(oldPID);
  expect(() => process.kill(oldPID, 0)).not.toThrow();
}, 60_000);

test('it joins a restart already in flight and reports its result without a second restore', async () => {
  const ctx = setupTest();

  // Each stub reports its own atc session as its agent session, so every
  // session a restart restores comes back under its own row.
  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const seed = await StateStore.open(join(daemon.stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-one'), cwd: ctx.home }),
    buildMockFleetEntry({ sessionID: toSessionID('s-two'), cwd: ctx.home }),
  ]);

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(
    async () => {
      const listed = await client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ alive: true }, { alive: true }] });
    },
    { timeoutMs: 20_000 },
  );

  const restarts = await Promise.all([
    runATC({
      command: ctx.atc,
      args: ['daemon', 'restart'],
      home: ctx.home,
      env: { PATH: ctx.path },
    }),
    runATC({
      command: ctx.atc,
      args: ['daemon', 'restart'],
      home: ctx.home,
      env: { PATH: ctx.path },
    }),
  ]);

  const finalPID = findDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid;

  const replacement = await daemon.openClient();

  await replacement.sendHello('atc/test');

  const listed = await waitFor(
    async () => {
      const read = await replacement.sendRequest('session.list');

      expect(read).toMatchObject({ sessions: [{ alive: true }, { alive: true }] });

      return read;
    },
    { timeoutMs: 20_000 },
  );

  expect(restarts.map((run) => run.exitCode)).toStrictEqual([0, 0]);

  expect(
    restarts.map((run) => /^daemon pid (?<pid>\d+), build/m.exec(run.stdout)?.groups?.['pid']),
  ).toStrictEqual([String(finalPID), String(finalPID)]);

  expect(getRecords(listed, 'sessions').map((s) => s['id'])).toIncludeSameMembers([
    's-one',
    's-two',
  ]);

  expect(restarts.filter((run) => run.stdout.includes('joins it'))).toHaveLength(1);
}, 90_000);

test('it completes a restart run from inside a hosted session after the session dies with the old daemon', async () => {
  const ctx = setupTest();

  // Each stub reports its own atc session as its agent session, so every
  // session a restart restores comes back under its own row.
  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const oldPID = daemon.proc.pid;

  const seed = await StateStore.open(join(daemon.stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-host'), name: 'host', cwd: ctx.home }),
  ]);

  writeFileSync(join(ctx.home, 'fake-claude-restart'), '');

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const last = await waitFor(
    () => {
      const parsed: unknown = JSON.parse(
        readFileSync(join(daemon.stateDir, 'restarts', 'last.json'), 'utf8'),
      );

      invariant(isRecord(parsed), 'last.json holds no record');

      return parsed;
    },
    { timeoutMs: 40_000, intervalMs: 100 },
  );

  const replacement = await daemon.openClient();

  await replacement.sendHello('atc/test');

  const listed = await waitFor(
    async () => {
      const read = await replacement.sendRequest('session.list');

      expect(read).toMatchObject({ sessions: [{ alive: true }] });

      return read;
    },
    { timeoutMs: 20_000 },
  );

  const record = findDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(last['code']).toBe(0);
  expect(record.pid).not.toBe(oldPID);
  expect(listed).toMatchObject({ sessions: [{ id: 's-host' }] });
  expect(existsSync(join(ctx.home, 'fake-claude-restart'))).toBeFalse();
}, 90_000);

test('it restarts through the unit when the daemon is the unit main process, handing off through systemd-run', async () => {
  const ctx = setupTest();

  // Each stub reports its own atc session as its agent session, so every
  // session a restart restores comes back under its own row.
  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const oldPID = daemon.proc.pid;

  ctx.fake.writeMainPID(oldPID);
  ctx.fake.placeInUnit(oldPID, 'atc-daemon.service');

  const seed = await StateStore.open(join(daemon.stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-one'), cwd: ctx.home }),
    buildMockFleetEntry({ sessionID: toSessionID('s-two'), cwd: ctx.home }),
  ]);

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(
    async () => {
      const listed = await client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ alive: true }, { alive: true }] });
    },
    { timeoutMs: 20_000 },
  );

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart'],
    home: ctx.home,
    env: { PATH: ctx.path, ATC_PROC_ROOT: ctx.fake.procRoot },
  });

  const replacement = await daemon.openClient();

  await replacement.sendHello('atc/test');

  const listed = await waitFor(
    async () => {
      const read = await replacement.sendRequest('session.list');

      expect(read).toMatchObject({ sessions: [{ alive: true }, { alive: true }] });

      return read;
    },
    { timeoutMs: 20_000 },
  );

  const runs = ctx.fake.readSystemdRunCalls();
  const record = findDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);
  expect(record.pid).not.toBe(oldPID);

  expect(getRecords(listed, 'sessions').map((s) => s['id'])).toIncludeSameMembers([
    's-one',
    's-two',
  ]);

  expect(restart.stdout).toInclude('replacement: systemd unit atc-daemon.service');

  expect(ctx.fake.readSystemctlCalls().filter((call) => call.includes('restart'))).toStrictEqual([
    '--user restart atc-daemon.service',
  ]);

  expect(runs).toHaveLength(1);
  expect(runs[0]).toInclude(`--setenv=HOME=${ctx.home}`);
  expect(runs[0]).toInclude('--unit atc-daemon-restart-');
}, 90_000);

test('it replaces a daemon on another protocol version and prints its refusal', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  daemon.proc.kill();

  await daemon.proc.exited;

  rmSync(daemon.socketPath, { force: true });

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'src', 'test-utils', 'run-stub-legacy-daemon.ts'),
      daemon.socketPath,
      daemon.stateDir,
    ],
    {
      env: { ...process.env, HOME: ctx.home, XDG_RUNTIME_DIR: ctx.home, PATH: ctx.path },
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );

  registerTestCleanup(() => {
    legacy.kill();
  });

  await waitFor(() => {
    expect(findDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(legacy.pid);
  });

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const replacement = await daemon.openClient();
  const hello = await replacement.sendHello('atc/test');

  const record = findDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);
  expect(record.pid).not.toBe(legacy.pid);
  expect(getString(hello, 'daemon')).toStartWith('atc/');
  expect(restart.stdout).toInclude('refused this build');
  expect(restart.stdout).toInclude('daemon atc/legacy-build speaks v');
  expect(restart.stdout).toInclude('daemon build atc/legacy-build speaks protocol v');
}, 60_000);

test('it prints the preflight and stops the daemon nowhere on a dry run', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const oldPID = daemon.proc.pid;

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart', '--dry-run'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  expect(restart.exitCode).toBe(0);
  expect(restart.stdout).toInclude(`daemon: pid ${oldPID}`);
  expect(restart.stdout).toInclude('the interrupted turn does not continue');
  expect(findDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(oldPID);
  expect(daemon.proc.exitCode).toBeNull();
});

test('it refuses a --listen without a token file before it stops the daemon', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const oldPID = daemon.proc.pid;

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart', '--listen', '127.0.0.1:0'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  expect(restart.exitCode).toBe(1);

  expect(restart.stdout).toInclude(
    '--listen and --token-file go together; the daemon was left running',
  );

  expect(findDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(oldPID);
  expect(daemon.proc.exitCode).toBeNull();
});
