import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_TARGET } from '@atc/config';
import { startDaemon } from '@atc/daemon';
import { buildStubTargets } from '@atc/daemon/testing';
import { readDaemonRecord } from '@atc/lifecycle';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import { openDaemonClient } from '@atc/protocol/client';
import {
  createMigratedStateDB,
  getString,
  registerTestCleanup,
  resolveATCCommand,
  runATC,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';

// The lock cases start their daemons in the test's process, each on sockets
// of its own name over one state directory.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-startup-');
  const home = temporaryDirectory.path;
  const stateDir = join(home, '.local', 'state', 'atc');

  return {
    home,
    stateDir,
    atc: resolveATCCommand(),
    buildDaemonOptions: (name: string) => ({
      socketPath: join(home, `${name}.sock`),
      reporterSocketPath: join(home, `${name}-reporter.sock`),
      statusPath: join(home, `${name}-status.json`),
      dbPath: join(stateDir, 'atc.db'),
      build: 'atc/test',
      targets: buildStubTargets([LOCAL_TARGET], { spawned: [] }),
      log: () => {},
    }),
  };
}

test('it lets exactly one of two daemons started at once serve a state directory', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
  createMigratedStateDB(join(ctx.stateDir, 'atc.db'));

  const settled = await Promise.allSettled([
    startDaemon(ctx.buildDaemonOptions('first')),
    startDaemon(ctx.buildDaemonOptions('second')),
  ]);

  const started = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );

  const refusals = settled.flatMap((result): unknown[] =>
    result.status === 'rejected' ? [result.reason] : [],
  );

  registerTestCleanup(() => Promise.all(started.map((daemon) => daemon.stop())));

  const record = readDaemonRecord(join(ctx.stateDir, 'daemon.json'));

  invariant(record !== null, 'the serving daemon wrote no record');

  const client = await openDaemonClient(record.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test')).resolves.toContainKey('daemonID');

  expect(record.socketPath).toBeOneOf([
    join(ctx.home, 'first.sock'),
    join(ctx.home, 'second.sock'),
  ]);

  expect(started).toHaveLength(1);

  expect(refusals).toMatchObject([
    {
      code: 'daemon_locked',
      message: expect.toStartWith(`atc daemon: another daemon already serves ${ctx.stateDir}`),
    },
  ]);
});

test('it refuses a second daemon with the pid and socket of the daemon that serves', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
  createMigratedStateDB(join(ctx.stateDir, 'atc.db'));

  const serving = await startDaemon(ctx.buildDaemonOptions('first'));

  registerTestCleanup(() => serving.stop());

  const refused = startDaemon(ctx.buildDaemonOptions('second'));

  expect(refused).rejects.toThrowWithMessage(
    Error,
    `atc daemon: another daemon already serves ${ctx.stateDir} (pid ${process.pid}, socket ${join(ctx.home, 'first.sock')})`,
  );
});

test('it keeps the state directory and every daemon socket owner-only under a permissive umask without XDG_RUNTIME_DIR', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');

  startDaemonProcess({
    command: ['/bin/sh', '-c', 'umask 000 && exec "$@"', 'sh', ...ctx.atc],
    home: ctx.home,
    env: { XDG_RUNTIME_DIR: undefined },
    freshState: true,
  });

  // The daemon writes its record once every socket is bound.
  await waitFor(() => statSync(join(stateDir, 'daemon.json')), { timeoutMs: 15_000 });

  const socketModes = ['atc-daemon.sock', 'atc.sock', 'atc-events.sock'].map(
    (name) => statSync(join(stateDir, name)).mode & 0o777,
  );

  expect(socketModes).toStrictEqual([0o600, 0o600, 0o600]);
  expect(statSync(stateDir).mode & 0o777).toBe(0o700);
});

test('it prints the running daemon id through atc daemon id', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();
  const hello = await client.sendHello('atc/test');
  const printed = await runATC({ command: ctx.atc, args: ['daemon', 'id'], home: ctx.home });

  expect(printed.stdout).toBe(`${getString(hello, 'daemonID')}\n`);
});

test('it exits nonzero from atc daemon id when no daemon answers', async () => {
  const ctx = setupTest();

  const printed = await runATC({ command: ctx.atc, args: ['daemon', 'id'], home: ctx.home });

  expect(printed.exitCode).toBe(1);
  expect(printed.stderr).toInclude('atc daemon id: no daemon at');
});

test.each([
  [['--listen', '0.0.0.0:0', '--token-file', '/dev/null'], "--listen refuses '0.0.0.0'"],
  [['--listen', '127.0.0.1:0'], '--listen and --token-file go together'],
])('it refuses to start a daemon with %j', async (args, message) => {
  const ctx = setupTest();

  const started = await runATC({ command: ctx.atc, args: ['daemon', ...args], home: ctx.home });

  expect(started.exitCode).toBe(1);
  expect(started.stderr).toInclude(message);
});

test('it refuses to start a daemon whose --listen port another socket holds, leaving no socket or record', async () => {
  const ctx = setupTest();
  const tokenFile = join(ctx.home, 'gateway-token');
  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    held.stop(true);
  });

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

  const started = await runATC({
    command: ctx.atc,
    args: ['daemon', '--listen', `127.0.0.1:${held.port}`, '--token-file', tokenFile],
    home: ctx.home,
  });

  expect(started.exitCode).toBe(1);

  expect(started.stderr).toBe(
    `atc daemon: --listen cannot bind 127.0.0.1:${held.port} (EADDRINUSE)\n`,
  );

  expect(existsSync(join(ctx.home, 'atc-daemon.sock'))).toBeFalse();
  expect(existsSync(join(ctx.home, '.local', 'state', 'atc', 'daemon.json'))).toBeFalse();
});

// The source entry keeps Bun's .env autoload, so these run on the compiled binary only. With no
// daemon running, `daemon id` prints the socket path it tried, which follows XDG_RUNTIME_DIR and
// so shows whether a variable reached the process.
test.skipIf(process.env['ATC_BIN'] === undefined)(
  'it ignores a .env file in the working directory of the compiled binary',
  async () => {
    const ctx = setupTest();

    writeFileSync(join(ctx.home, '.env'), `XDG_RUNTIME_DIR=${join(ctx.home, 'from-dotenv')}\n`);

    const result = await runATC({
      command: ctx.atc,
      args: ['daemon', 'id'],
      home: ctx.home,
      cwd: ctx.home,
      env: { XDG_RUNTIME_DIR: undefined },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toInclude(join(ctx.home, '.local', 'state', 'atc', 'atc-daemon.sock'));
    expect(result.stderr).not.toInclude('from-dotenv');
  },
);

test.skipIf(process.env['ATC_BIN'] === undefined)(
  'it keeps an explicitly inherited variable in the compiled binary',
  async () => {
    const ctx = setupTest();

    writeFileSync(join(ctx.home, '.env'), `XDG_RUNTIME_DIR=${join(ctx.home, 'from-dotenv')}\n`);

    const result = await runATC({
      command: ctx.atc,
      args: ['daemon', 'id'],
      home: ctx.home,
      cwd: ctx.home,
      env: { XDG_RUNTIME_DIR: join(ctx.home, 'from-process-env') },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toInclude(join(ctx.home, 'from-process-env', 'atc-daemon.sock'));
  },
);

// Claude kills a hook past its 5 s limit, and on a busy guest the start's CPU cost decides that.
// Runners of one type differ twofold in speed, so the budget is a multiple of a bare Bun start
// measured on the same machine, with the two kinds of start interleaved.
test.skipIf(process.env['ATC_BIN'] === undefined)(
  'it starts the hook reporter of the compiled binary within a fixed multiple of the CPU time of a bare Bun start',
  async () => {
    const ctx = setupTest();
    const exitCodes: number[] = [];
    const reporterCPUMs: number[] = [];
    const bareCPUMs: number[] = [];

    const starts: [command: string[], cpuMs: number[]][] = [
      [[...ctx.atc, 'hook-report', '--agent', 'claude'], reporterCPUMs],
      [[process.execPath, '-e', '0'], bareCPUMs],
    ];

    // Nine starts of each give medians that one noisy start cannot move.
    for (let run = 0; run < 9; run += 1) {
      for (const [command, cpuMs] of starts) {
        // Without an event socket the reporter exits once started, so its cost is the start alone.
        const subprocess = Bun.spawn(command, {
          cwd: ctx.home,
          env: { PATH: process.env['PATH'], HOME: ctx.home },
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });

        const exitCode = await subprocess.exited;

        exitCodes.push(exitCode);

        const usage = subprocess.resourceUsage();

        invariant(usage);

        // oxlint-disable-next-line no-unnecessary-type-conversion -- the types declare a number, while Bun returns the microseconds as a bigint, which division by a number throws on
        cpuMs.push(Number(usage.cpuTime.total) / 1000);
      }
    }

    // A bare start costs relatively more on macOS. Each multiple sits about halfway between a
    // healthy start and one that parses the whole bundle.
    const multiples: Partial<Record<string, number>> = { linux: 16, darwin: 8 };
    const multiple = multiples[process.platform];
    const reporterMedian = reporterCPUMs.toSorted((left, right) => left - right).at(4);
    const bareMedian = bareCPUMs.toSorted((left, right) => left - right).at(4);

    invariant(multiple !== undefined, `no startup budget for ${process.platform}`);
    invariant(reporterMedian !== undefined && bareMedian !== undefined);

    // A start that fails before its work counts as a failure, not as a cheap start.
    expect(exitCodes).toStrictEqual(Array.from({ length: 18 }, () => 0));
    expect(reporterMedian).toBeLessThan(multiple * bareMedian);
  },
);
