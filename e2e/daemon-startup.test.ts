import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { findDaemonRecord } from '../src/shared/find-daemon-record';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';

/**
 * A fresh home for the daemons and atc commands a test starts; a daemon
 * that finds no config there writes its own on first run.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-startup-');

  return { home: tmp.dir, atc: resolveATCCommand() };
}

test('it lets exactly one of two daemons started at once serve a state directory', async () => {
  const ctx = setupTest();
  const first = startDaemonProcess({ command: ctx.atc, home: ctx.home });
  const second = startDaemonProcess({ command: ctx.atc, home: ctx.home });
  const daemons = [first, second] as const;

  const loserIndex = await Promise.race(
    daemons.map(async (daemon, index) => {
      await daemon.proc.exited;

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

  expect(loser.proc.exitCode).toBe(1);
  expect(Bun.peek.status(winner.proc.exited)).toBe('pending');

  expect(findDaemonRecord(join(first.stateDir, 'daemon.json'))).toStrictEqual({
    pid: winner.proc.pid,
    socketPath: first.socketPath,
    reporterSocketPath: first.reporterSocketPath,
    eventsSocketPath: join(ctx.home, 'atc-events.sock'),
    listenPort: null,
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

  const code = await refused.proc.exited;

  expect(code).toBe(1);

  expect(refused.readStderr()).toBe(
    `atc daemon: another daemon already serves ${serving.stateDir} (pid ${serving.proc.pid}, socket ${serving.socketPath})\n`,
  );
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

// A compiled binary loads no .env file from its working directory, while the
// source entry keeps Bun's runtime autoload, so these run on the binary only.
// With no daemon running, `daemon id` prints the socket path it tried, which
// follows XDG_RUNTIME_DIR and so shows whether a variable reached the process.
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

// Claude kills a hook that runs past its 5 s limit. A hook starts at the
// same moment as the session's other atc processes on a guest of two vCPUs,
// so the CPU a start costs, not its wall time on an idle runner, decides
// whether it finishes in time. One runner type can differ twofold in speed
// from one machine to the next, so the budget is a multiple of a bare start
// of the Bun runtime, which this file runs under and the binary embeds,
// measured on the same machine with its starts interleaved with the
// reporter's. A bare start costs relatively more on macOS, so the multiple
// is per platform, about halfway between a healthy start and one that parses
// the whole bundle. Nine starts of each give medians that one noisy start
// cannot move. Without an event socket the reporter exits as soon as it
// starts, so its median is the start alone, and a start that fails before
// its work counts as a failure, not as a cheap start.
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

    for (let run = 0; run < 9; run += 1) {
      for (const [command, cpuMs] of starts) {
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

        // The types declare a number, while Bun returns the microseconds as a
        // bigint, which division by a number throws on.
        // oxlint-disable-next-line no-unnecessary-type-conversion
        cpuMs.push(Number(usage.cpuTime.total) / 1000);
      }
    }

    const multiples: Partial<Record<string, number>> = { linux: 16, darwin: 8 };
    const multiple = multiples[process.platform];
    const reporterMedian = reporterCPUMs.toSorted((a, b) => a - b).at(4);
    const bareMedian = bareCPUMs.toSorted((a, b) => a - b).at(4);

    invariant(multiple !== undefined, `no startup budget for ${process.platform}`);
    invariant(reporterMedian !== undefined && bareMedian !== undefined);

    expect(exitCodes).toStrictEqual(Array.from({ length: 18 }, () => 0));
    expect(reporterMedian).toBeLessThan(multiple * bareMedian);
  },
);
