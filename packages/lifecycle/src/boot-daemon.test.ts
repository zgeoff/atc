import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config/host';
import { PROTOCOL_V } from '@atc/protocol/wire';
import {
  buildStubClock,
  registerTestCleanup,
  setupTempDir,
  startStubLegacyDaemon,
  startStubUnansweringUnixListener,
  waitFor,
} from '@atc/test-utils';
import { bootDaemonClient } from './boot-daemon';
import { buildMockLifecycleHost } from './testing/build-mock-lifecycle-host';

/**
 * A fresh home that serves as both the client's home and its runtime
 * directory, so the host's paths put the daemon's socket at `sockPath` and
 * its state directory at `stateDir`, and the path of the stand-in daemon
 * of another protocol. The cases that boot a real daemon run end to end.
 */
function setupTest() {
  const tmp = setupTempDir('atc-boot-daemon-');
  const stateDir = join(tmp.dir, '.local', 'state', 'atc');

  // The daemon and the client both expect the state directory to exist.
  mkdirSync(stateDir, { recursive: true });

  return {
    dir: tmp.dir,
    stateDir,
    sockPath: join(tmp.dir, 'atc-daemon.sock'),
    paths: resolvePaths({ HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir }),
    legacyDaemon: join(
      import.meta.dir,
      '..',
      '..',
      'test-utils',
      'src',
      'run-stub-legacy-daemon.ts',
    ),
  };
}

test('it leaves a daemon on another protocol running and rejects with both builds and versions', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn([process.execPath, ctx.legacyDaemon, ctx.sockPath, ctx.stateDir], {
    stdout: 'pipe',
    stderr: 'inherit',
  });

  registerTestCleanup(async () => {
    legacy.kill('SIGTERM');

    await legacy.exited;
  });

  const up = await legacy.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(up.value).trim().split(' ')[1]);

  // The argv starts nothing, so a boot that tried to start a daemon fails.
  const host = buildMockLifecycleHost({ paths: ctx.paths });

  expect(bootDaemonClient(host)).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: [
      `the atc daemon (pid ${legacy.pid}, socket ${ctx.sockPath}) speaks another protocol than this client, atc/test-build on protocol v${PROTOCOL_V}.`,
      `The daemon answered: atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
      'It was left running, so the sessions it hosts keep running.',
      'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.',
    ].join('\n'),
  });

  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();
});

test('it leaves a daemon on another protocol running and rejects when the caller declines the restart', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn([process.execPath, ctx.legacyDaemon, ctx.sockPath, ctx.stateDir], {
    stdout: 'pipe',
    stderr: 'inherit',
  });

  registerTestCleanup(async () => {
    legacy.kill('SIGTERM');

    await legacy.exited;
  });

  const up = await legacy.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(up.value).trim().split(' ')[1]);
  const asked: (number | null)[] = [];

  const booting = bootDaemonClient(buildMockLifecycleHost({ paths: ctx.paths }), {
    onProtocolMismatch: (mismatch) => {
      asked.push(mismatch.daemonPID);

      return Promise.resolve(false);
    },
  });

  expect(booting).rejects.toMatchObject({ code: 'protocol_mismatch' });
  expect(asked).toStrictEqual([legacy.pid]);
  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();
});

test('it never asks to restart a daemon on another protocol whose pid it cannot find', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn([process.execPath, ctx.legacyDaemon, ctx.sockPath, ctx.stateDir], {
    stdout: 'pipe',
    stderr: 'inherit',
  });

  registerTestCleanup(async () => {
    legacy.kill('SIGTERM');

    await legacy.exited;
  });

  const up = await legacy.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(up.value).trim().split(' ')[1]);

  rmSync(join(ctx.stateDir, 'daemon.json'));

  const asked: (number | null)[] = [];

  const booting = bootDaemonClient(buildMockLifecycleHost({ paths: ctx.paths }), {
    onProtocolMismatch: (mismatch) => {
      asked.push(mismatch.daemonPID);

      return Promise.resolve(true);
    },
  });

  expect(booting).rejects.toMatchObject({ code: 'protocol_mismatch' });
  expect(asked).toStrictEqual([]);
  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();
});

test('it rejects with the socket it waited on, and starts no daemon, when none answers before the wait ends', async () => {
  const ctx = setupTest();
  const clock = buildStubClock(0);
  const notices: string[] = [];

  const booting = bootDaemonClient(buildMockLifecycleHost({ paths: ctx.paths }), {
    waitForDaemonMs: 300,
    clock,
    onWaitForDaemon: () => {
      notices.push('waiting without starting a daemon');
    },
  });

  // The wait polls every 100 ms of the stepped clock, so a 300 ms wait
  // misses four polls: the test steps past three of them and the fourth
  // ends the wait.
  const steps: number[] = [];

  for (let poll = 0; poll < 3; poll++) {
    const pending = await waitFor(() => {
      const [next] = clock.collectPending();

      if (next === undefined) {
        throw new Error('no poll is waiting');
      }

      return next;
    });

    steps.push(pending);
    clock.advance(100);
  }

  expect(booting).rejects.toThrowWithMessage(
    Error,
    `no atc daemon answered at ${ctx.sockPath} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );

  expect(notices).toStrictEqual(['waiting without starting a daemon']);
  expect(steps).toStrictEqual([100, 100, 100]);
  expect(existsSync(join(ctx.stateDir, 'daemon.lock'))).toBeFalse();
  expect(existsSync(ctx.sockPath)).toBeFalse();
});

test('it rejects when a socket takes the connection but never answers the handshake before the wait ends', async () => {
  const ctx = setupTest();
  const clock = buildStubClock(0);

  startStubUnansweringUnixListener(ctx.sockPath);

  const booting = bootDaemonClient(buildMockLifecycleHost({ paths: ctx.paths }), {
    waitForDaemonMs: 300,
    clock,
  });

  // The socket takes the connection, so the boot waits on the handshake
  // until the stepped clock reaches the end of the wait.
  const step = await waitFor(() => {
    const [pending] = clock.collectPending();

    if (pending === undefined) {
      throw new Error('no handshake wait is pending');
    }

    return pending;
  });

  clock.advance(step);

  expect(booting).rejects.toThrowWithMessage(
    Error,
    `no atc daemon answered at ${ctx.sockPath} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );

  expect(step).toBe(300);
});

test('it reports the start of a wait once across every poll of that wait', async () => {
  const ctx = setupTest();
  const clock = buildStubClock(0);
  let waits = 0;

  const booting = bootDaemonClient(buildMockLifecycleHost({ paths: ctx.paths }), {
    waitForDaemonMs: 500,
    clock,
    onWaitForDaemon: () => {
      waits += 1;
    },
  });

  // The wait polls every 100 ms of the stepped clock, so a 500 ms wait
  // misses six polls: the test steps past five of them and the sixth ends
  // the wait.
  const steps: number[] = [];

  for (let poll = 0; poll < 5; poll++) {
    const pending = await waitFor(() => {
      const [next] = clock.collectPending();

      if (next === undefined) {
        throw new Error('no poll is waiting');
      }

      return next;
    });

    steps.push(pending);
    clock.advance(100);
  }

  expect(booting).rejects.toThrowWithMessage(
    Error,
    `no atc daemon answered at ${ctx.sockPath} within 0.5s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );

  expect(waits).toBe(1);
  expect(steps).toStrictEqual([100, 100, 100, 100, 100]);
});

test('it waits for a daemon instead of starting one when the host finds an installed user unit', async () => {
  const ctx = setupTest();
  const clock = buildStubClock(0);

  const booting = bootDaemonClient(
    buildMockLifecycleHost({
      paths: ctx.paths,
      findManagedUnit: () => join(ctx.dir, 'atc-daemon.service'),
    }),
    { clock, onWaitForDaemon: () => {} },
  );

  const step = await waitFor(() => {
    const [pending] = clock.collectPending();

    if (pending === undefined) {
      throw new Error('no poll is waiting');
    }

    return pending;
  });

  startStubLegacyDaemon(ctx.sockPath);

  clock.advance(step);

  const boot = await booting;

  registerTestCleanup(() => {
    boot.client.stop();
  });

  expect(boot.socketPath).toBe(ctx.sockPath);
  expect(step).toBe(100);
});

test('it waits for its own daemon while a boot on the same clock waits for another', async () => {
  const first = setupTest();
  const second = setupTest();
  const clock = buildStubClock(0);

  // The argv starts nothing, and the clock never reaches the end of the
  // first boot's wait, so that boot neither settles nor rejects.
  void bootDaemonClient(buildMockLifecycleHost({ paths: first.paths }), { clock });

  await waitFor(() => {
    if (clock.collectPending().length === 0) {
      throw new Error('the first boot is not waiting yet');
    }
  });

  const booting = bootDaemonClient(buildMockLifecycleHost({ paths: second.paths }), { clock });

  await waitFor(() => {
    if (clock.collectPending().length < 2) {
      throw new Error('the second boot is not waiting on its own daemon');
    }
  });

  startStubLegacyDaemon(second.sockPath, { replies: { 'daemon.hello': { daemon: 'atc/1.2.3' } } });

  clock.advance(100);

  const boot = await booting;

  registerTestCleanup(() => {
    boot.client.stop();
  });

  expect(boot.socketPath).toBe(second.sockPath);
});

test('it rejects with the socket path it is given when a wait finds no daemon there', () => {
  const ctx = setupTest();

  expect(
    bootDaemonClient(buildMockLifecycleHost(), {
      waitForDaemonMs: 0,
      paths: {
        socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
        recordFile: join(ctx.dir, 'given', 'daemon.json'),
        pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
      },
    }),
  ).rejects.toThrowWithMessage(
    Error,
    `no atc daemon answered at ${join(ctx.dir, 'given', 'atc-daemon.sock')} within 0s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );
});

test('it rejects at once, saying a boot given its own paths starts no daemon, when none answers there', () => {
  const ctx = setupTest();

  expect(
    bootDaemonClient(buildMockLifecycleHost(), {
      paths: {
        socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
        recordFile: join(ctx.dir, 'given', 'daemon.json'),
        pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
      },
    }),
  ).rejects.toThrowWithMessage(
    Error,
    `no atc daemon answered at ${join(ctx.dir, 'given', 'atc-daemon.sock')}, and a boot given its own daemon paths does not start one; start \`atc daemon\` where it listens there first`,
  );
});

test('it reads the pid of a daemon on another protocol from the pid file at the paths it is given', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'given'));
  startStubLegacyDaemon(join(ctx.dir, 'given', 'atc-daemon.sock'), { protocol: PROTOCOL_V + 1 });
  writeFileSync(join(ctx.dir, 'given', 'atc-daemon.pid'), '4242');

  expect(
    bootDaemonClient(buildMockLifecycleHost(), {
      paths: {
        socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
        recordFile: join(ctx.dir, 'given', 'daemon.json'),
        pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
      },
    }),
  ).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: expect.toStartWith(
      `the atc daemon (pid 4242, socket ${join(ctx.dir, 'given', 'atc-daemon.sock')}) speaks another protocol than this client`,
    ),
  });
});

test('it reads the pid of a daemon on another protocol from the record at the paths it is given', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'given'));
  startStubLegacyDaemon(join(ctx.dir, 'given', 'atc-daemon.sock'), { protocol: PROTOCOL_V + 1 });

  writeFileSync(
    join(ctx.dir, 'given', 'daemon.json'),
    JSON.stringify({
      pid: 4343,
      socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.dir, 'given', 'atc.sock'),
      eventsSocketPath: null,
      listenPort: null,
    }),
  );

  expect(
    bootDaemonClient(buildMockLifecycleHost(), {
      paths: {
        socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
        recordFile: join(ctx.dir, 'given', 'daemon.json'),
        pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
      },
    }),
  ).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: expect.toStartWith(
      `the atc daemon (pid 4343, socket ${join(ctx.dir, 'given', 'atc-daemon.sock')}) speaks another protocol than this client`,
    ),
  });
});
