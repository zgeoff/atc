import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, toAgentID } from '@atc/core';
import { readDaemonRecord } from '@atc/lifecycle';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  createStubClaude,
  createStubComposer,
  createStubSystemd,
  getRecords,
  getString,
  registerTestCleanup,
  resolveATCCommand,
  runATC,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-restart-');
  const atc = resolveATCCommand();
  const fake = createStubSystemd(atc);
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, {
      atc,
      composer: createStubComposer(temporaryDirectory.path),
    }),
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

  const oldPID = daemon.subprocess.pid;

  const seed = await createStateStore(join(daemon.stateDir, 'atc.db'));

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
    { timeoutMs: 10_000 },
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
    { timeoutMs: 10_000 },
  );

  const build = getString(hello, 'daemon');
  const record = readDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);
  expect(record.pid).not.toBe(oldPID);
  expect(() => process.kill(oldPID, 0)).toThrow();

  expect(getRecords(listed, 'sessions').map((session) => session['id'])).toIncludeSameMembers([
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
});

test('it puts one DaemonRestarted event with the restart result on the replacement daemon feed', async () => {
  const ctx = setupTest();
  const eventsFile = join(ctx.home, 'restarted.jsonl');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
      restoreFleetOnRestart: false,

      // One printf writes each event line whole, so a read never sees half of one.
      hooks: {
        DaemonRestarted: [{ command: `printf '%s\\n' "$(cat)" >> '${eventsFile}'` }],
      },
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();
  const hello = await client.sendHello('atc/test');

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const lines = await waitFor(
    () => {
      invariant(existsSync(eventsFile), 'no DaemonRestarted hook ran yet');

      const written = readFileSync(eventsFile, 'utf8');

      invariant(written.endsWith('\n'), 'the DaemonRestarted hook is still writing');

      return written.split('\n').filter((line) => line !== '');
    },
    { timeoutMs: 10_000 },
  );

  const record = readDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);

  expect(lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      version: PROTOCOL_V,
      ev: 'DaemonRestarted',
      result: {
        runID: expect.toBeString(),
        code: 0,
        pid: record.pid,
        build: getString(hello, 'daemon'),
        listenPort: null,
        restored: 0,
        total: 0,
        failed: [],
        interrupted: [],
        error: null,
      },
    },
  ]);
});

test('it returns the restart result from events.read to a reader that connects after the restart with a cursor saved before it', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ agents: { claude: { bin: ctx.claude } }, restoreFleetOnRestart: false }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const before = await daemon.openClient();
  const hello = await before.sendHello('atc/test');
  const first = await before.sendRequest('events.read', {});

  const saved = getString(first, 'cursor');

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const after = await daemon.openClient();

  await after.sendHello('atc/test');

  const page = await after.sendRequest('events.read', { cursor: saved, waitMs: 10_000 });

  const record = readDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);

  expect(page).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: '',
        name: null,
        kind: 'daemon-restarted',
        detail: 'restored 0 of 0',
        result: {
          runID: expect.toBeString(),
          code: 0,
          pid: record.pid,
          build: getString(hello, 'daemon'),
          listenPort: null,
          restored: 0,
          total: 0,
          failed: [],
          interrupted: [],
          error: null,
        },
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });
});

test('it puts the result of a refused restart on the feed of the daemon it left running', async () => {
  const ctx = setupTest();
  const eventsFile = join(ctx.home, 'restarted.jsonl');

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
      restoreFleetOnRestart: false,

      // One printf writes each event line whole, so a read never sees half of one.
      hooks: {
        DaemonRestarted: [{ command: `printf '%s\\n' "$(cat)" >> '${eventsFile}'` }],
      },
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart', '--listen', '127.0.0.1:0'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const lines = await waitFor(
    () => {
      invariant(existsSync(eventsFile), 'no DaemonRestarted hook ran yet');

      const written = readFileSync(eventsFile, 'utf8');

      invariant(written.endsWith('\n'), 'the DaemonRestarted hook is still writing');

      return written.split('\n').filter((line) => line !== '');
    },
    { timeoutMs: 10_000 },
  );

  expect(restart.exitCode).toBe(1);

  expect(lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      version: PROTOCOL_V,
      ev: 'DaemonRestarted',
      result: {
        runID: expect.toBeString(),
        code: 1,
        pid: null,
        build: null,
        listenPort: null,
        restored: 0,
        total: 0,
        failed: [],
        interrupted: [],
        error: '--listen and --token-file go together; the daemon was left running',
      },
    },
  ]);
});

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

  const seed = await createStateStore(join(daemon.stateDir, 'atc.db'));

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
    args: ['daemon', 'restart'],
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
      .map((session) => ({ id: session['id'], alive: session['alive'] })),
  ).toStrictEqual([{ id: 's-good', alive: true }]);

  expect(restart.stdout).toInclude(
    'failed: dropped (s-dropped): listed in state running without a terminal: no adapter for',
  );

  expect(restart.stdout).toInclude('restored 1 of 2');
});

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

  const oldPID = daemon.subprocess.pid;

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
  expect(readDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(oldPID);
  expect(() => process.kill(oldPID, 0)).not.toThrow();
});

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

  const seed = await createStateStore(join(daemon.stateDir, 'atc.db'));

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
    { timeoutMs: 10_000 },
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

  const finalPID = readDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid;

  const replacement = await daemon.openClient();

  await replacement.sendHello('atc/test');

  const listed = await waitFor(
    async () => {
      const read = await replacement.sendRequest('session.list');

      expect(read).toMatchObject({ sessions: [{ alive: true }, { alive: true }] });

      return read;
    },
    { timeoutMs: 10_000 },
  );

  expect(restarts.map((run) => run.exitCode)).toStrictEqual([0, 0]);

  expect(
    restarts.map((run) => /^daemon pid (?<pid>\d+), build/mu.exec(run.stdout)?.groups?.['pid']),
  ).toStrictEqual([String(finalPID), String(finalPID)]);

  expect(getRecords(listed, 'sessions').map((session) => session['id'])).toIncludeSameMembers([
    's-one',
    's-two',
  ]);

  expect(restarts.filter((run) => run.stdout.includes('joins it'))).toHaveLength(1);
});

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

  const oldPID = daemon.subprocess.pid;

  const seed = await createStateStore(join(daemon.stateDir, 'atc.db'));

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
    { timeoutMs: 10_000, intervalMs: 100 },
  );

  const replacement = await daemon.openClient();

  await replacement.sendHello('atc/test');

  const listed = await waitFor(
    async () => {
      const read = await replacement.sendRequest('session.list');

      expect(read).toMatchObject({ sessions: [{ alive: true }] });

      return read;
    },
    { timeoutMs: 10_000 },
  );

  const record = readDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(last['code']).toBe(0);
  expect(record.pid).not.toBe(oldPID);
  expect(listed).toMatchObject({ sessions: [{ id: 's-host' }] });
  expect(existsSync(join(ctx.home, 'fake-claude-restart'))).toBeFalse();
});

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

  const oldPID = daemon.subprocess.pid;

  ctx.fake.writeMainPID(oldPID);
  ctx.fake.writeUnitCgroup(oldPID, 'atc-daemon.service');

  const seed = await createStateStore(join(daemon.stateDir, 'atc.db'));

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
    { timeoutMs: 10_000 },
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
    { timeoutMs: 10_000 },
  );

  const runs = ctx.fake.readSystemdRunCalls();
  const record = readDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);
  expect(record.pid).not.toBe(oldPID);

  expect(getRecords(listed, 'sessions').map((session) => session['id'])).toIncludeSameMembers([
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
});

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

  daemon.subprocess.kill();

  await daemon.subprocess.exited;

  rmSync(daemon.socketPath, { force: true });

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
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
    expect(readDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(legacy.pid);
  });

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  const replacement = await daemon.openClient();
  const hello = await replacement.sendHello('atc/test');

  const record = readDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  invariant(record !== null, 'the state directory records no daemon');

  expect(restart.exitCode).toBe(0);
  expect(record.pid).not.toBe(legacy.pid);
  expect(getString(hello, 'daemon')).toStartWith('atc/');
  expect(restart.stdout).toInclude('refused this build');
  expect(restart.stdout).toInclude('daemon atc/legacy-build speaks v');
  expect(restart.stdout).toInclude('daemon build atc/legacy-build speaks protocol v');
});

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

  const oldPID = daemon.subprocess.pid;

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart', '--dry-run'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  // A request answered after the dry run proves the daemon still serves.
  await client.sendRequest('session.list');

  expect(restart.exitCode).toBe(0);
  expect(restart.stdout).toInclude(`daemon: pid ${oldPID}`);
  expect(restart.stdout).toInclude('the interrupted turn does not continue');
  expect(readDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(oldPID);
  expect(Bun.peek.status(daemon.subprocess.exited)).toBe('pending');
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

  const oldPID = daemon.subprocess.pid;

  const restart = await runATC({
    command: ctx.atc,
    args: ['daemon', 'restart', '--listen', '127.0.0.1:0'],
    home: ctx.home,
    env: { PATH: ctx.path },
  });

  // A request answered after the refusal proves the daemon still serves.
  await client.sendRequest('session.list');

  expect(restart.exitCode).toBe(1);

  expect(restart.stdout).toInclude(
    '--listen and --token-file go together; the daemon was left running',
  );

  expect(readDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.pid).toBe(oldPID);
  expect(Bun.peek.status(daemon.subprocess.exited)).toBe('pending');
});
