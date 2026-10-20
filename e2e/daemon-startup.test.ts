import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonRecord } from '@atc/lifecycle';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import { getString, resolveATCCommand, runATC, setupTempDir, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';

function setupTest() {
  const tmp = setupTempDir('atc-e2e-startup-');

  return { home: tmp.path, atc: resolveATCCommand() };
}

test('it lets exactly one of two daemons started at once serve a state directory', async () => {
  const ctx = setupTest();
  const first = startDaemonProcess({ command: ctx.atc, home: ctx.home });
  const second = startDaemonProcess({ command: ctx.atc, home: ctx.home });
  const daemons = [first, second] as const;

  const loserIndex = await Promise.race(
    daemons.map(async (daemon, index) => {
      await daemon.subprocess.exited;

      return index;
    }),
  );

  const loser = daemons[loserIndex];
  const winner = daemons[1 - loserIndex];

  invariant(loser !== undefined && winner !== undefined, 'no daemon exited first');

  // The loser can exit before the winner binds its socket, so the client
  // waits on the daemon that still runs.
  const client = await winner.openClient();

  await client.sendHello('atc/test');

  expect(loser.subprocess.exitCode).toBe(1);
  expect(Bun.peek.status(winner.subprocess.exited)).toBe('pending');

  expect(readDaemonRecord(join(first.stateDir, 'daemon.json'))).toStrictEqual({
    pid: winner.subprocess.pid,
    socketPath: first.socketPath,
    reporterSocketPath: first.reporterSocketPath,
    eventsSocketPath: join(ctx.home, 'atc-events.sock'),
    listenPort: null,
    protocol: 6,
  });

  expect(loser.readStderr()).toStartWith(
    `atc daemon: another daemon already serves ${first.stateDir}`,
  );
});

test('it refuses a second daemon with the pid and socket of the daemon that serves', async () => {
  const ctx = setupTest();
  const serving = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await serving.openClient();

  await client.sendHello('atc/test');

  const refused = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const code = await refused.subprocess.exited;

  expect(code).toBe(1);

  expect(refused.readStderr()).toBe(
    `atc daemon: another daemon already serves ${serving.stateDir} (pid ${serving.subprocess.pid}, socket ${serving.socketPath})\n`,
  );
});

test('it keeps the state directory and every daemon socket owner-only under a permissive umask without XDG_RUNTIME_DIR', async () => {
  const ctx = setupTest();
  const stateDir = join(ctx.home, '.local', 'state', 'atc');

  startDaemonProcess({
    command: ['/bin/sh', '-c', 'umask 000 && exec "$@"', 'sh', ...ctx.atc],
    home: ctx.home,
    env: { XDG_RUNTIME_DIR: undefined },
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
        const proc = Bun.spawn(command, {
          cwd: ctx.home,
          env: { PATH: process.env['PATH'], HOME: ctx.home },
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });

        const exitCode = await proc.exited;

        exitCodes.push(exitCode);

        const usage = proc.resourceUsage();

        invariant(usage);

        // oxlint-disable-next-line no-unnecessary-type-conversion -- the types declare a number, while Bun returns the microseconds as a bigint, which division by a number throws on
        cpuMs.push(Number(usage.cpuTime.total) / 1000);
      }
    }

    // A bare start costs relatively more on macOS. Each multiple sits about halfway between a
    // healthy start and one that parses the whole bundle.
    const multiples: Partial<Record<string, number>> = { linux: 16, darwin: 8 };
    const multiple = multiples[process.platform];
    const reporterMedian = reporterCPUMs.toSorted((a, b) => a - b).at(4);
    const bareMedian = bareCPUMs.toSorted((a, b) => a - b).at(4);

    invariant(multiple !== undefined, `no startup budget for ${process.platform}`);
    invariant(reporterMedian !== undefined && bareMedian !== undefined);

    // A start that fails before its work counts as a failure, not as a cheap start.
    expect(exitCodes).toStrictEqual(Array.from({ length: 18 }, () => 0));
    expect(reporterMedian).toBeLessThan(multiple * bareMedian);
  },
);
