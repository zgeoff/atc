import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_V } from '@atc/protocol/protocol';
import { readJSONRecord } from '@atc/test-utils/read-json-record';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { startStubLegacyDaemon } from '@atc/test-utils/start-stub-legacy-daemon';
import { startStubUnansweringUnixListener } from '@atc/test-utils/start-stub-unanswering-unix-listener';
import { bootDaemonClient } from './boot-daemon';

/**
 * A fresh home for a client process: `dir` serves as both its home and its
 * runtime directory, so the client computes `sockPath` as the daemon's
 * socket and `stateDir` as the daemon's state directory. The client reads
 * those paths once at import, so each test boots it in a subprocess with
 * `env`. The cases that boot a real daemon run end to end.
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
    env: { ...process.env, HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir },
  };
}

test('it leaves a daemon on another protocol running and rejects with both builds and versions', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', '..', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(async () => {
    legacy.kill('SIGTERM');

    await legacy.exited;
  });

  const up = await legacy.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(up.value).trim().split(' ')[1]);

  // The argv starts nothing, so a boot that tried to start a daemon fails.
  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const outcome = await bootDaemonClient({ argv: ['false'], readBuild: () => 'atc/test-build' }).then(
  (boot) => { boot.client.stop(); return { booted: true }; },
  (error) => ({ code: error.code, message: error.message }),
);
process.stdout.write(JSON.stringify(outcome));
process.exit(0);
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const listening = await Bun.connect({ unix: ctx.sockPath, socket: { data: () => {} } });

  registerTestCleanup(() => {
    listening.end();
  });

  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();

  expect(JSON.parse(stdout)).toStrictEqual({
    code: 'protocol_mismatch',
    message: [
      `the atc daemon (pid ${legacy.pid}, socket ${ctx.sockPath}) speaks another protocol than this client, atc/test-build on protocol v${PROTOCOL_V}.`,
      `The daemon answered: atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
      'It was left running, so the sessions it hosts keep running.',
      'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.',
    ].join('\n'),
  });
});

test('it leaves a daemon on another protocol running and rejects when the caller declines the restart', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', '..', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(async () => {
    legacy.kill('SIGTERM');

    await legacy.exited;
  });

  const up = await legacy.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(up.value).trim().split(' ')[1]);

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const asked = [];
const outcome = await bootDaemonClient({ argv: ['false'], readBuild: () => 'atc/test-build' }, {
  onProtocolMismatch: (mismatch) => { asked.push(mismatch.daemonPID); return Promise.resolve(false); },
}).then(
  (boot) => { boot.client.stop(); return { booted: true }; },
  (error) => ({ code: error.code }),
);
process.stdout.write(JSON.stringify({ asked, outcome }));
process.exit(0);
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const listening = await Bun.connect({ unix: ctx.sockPath, socket: { data: () => {} } });

  registerTestCleanup(() => {
    listening.end();
  });

  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();

  const out = await readJSONRecord(new Response(stdout));

  expect(out['asked']).toStrictEqual([legacy.pid]);
  expect(out['outcome']).toStrictEqual({ code: 'protocol_mismatch' });
});

test('it never asks to restart a daemon on another protocol whose pid it cannot find', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', '..', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(async () => {
    legacy.kill('SIGTERM');

    await legacy.exited;
  });

  const up = await legacy.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(up.value).trim().split(' ')[1]);

  rmSync(join(ctx.stateDir, 'daemon.json'));

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const asked = [];
const outcome = await bootDaemonClient({ argv: ['false'], readBuild: () => 'atc/test-build' }, {
  onProtocolMismatch: (mismatch) => { asked.push(mismatch.daemonPID); return Promise.resolve(true); },
}).then(
  (boot) => { boot.client.stop(); return { booted: true }; },
  (error) => ({ code: error.code }),
);
process.stdout.write(JSON.stringify({ asked, outcome }));
process.exit(0);
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const listening = await Bun.connect({ unix: ctx.sockPath, socket: { data: () => {} } });

  registerTestCleanup(() => {
    listening.end();
  });

  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();

  const out = await readJSONRecord(new Response(stdout));

  expect(out['asked']).toStrictEqual([]);
  expect(out['outcome']).toStrictEqual({ code: 'protocol_mismatch' });
});

test('it rejects with the socket it waited on, and starts no daemon, when none answers before the wait ends', async () => {
  const ctx = setupTest();

  // The wait polls every 100 ms of the stepped clock, so a 300 ms wait
  // misses four polls: the probe steps past three of them and the fourth
  // ends the wait.
  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
import { buildStubClock } from '${join(import.meta.dir, '..', '..', 'test-utils', 'src', 'build-stub-clock.ts')}';
import { waitFor } from '${join(import.meta.dir, '..', '..', 'test-utils', 'src', 'wait-for.ts')}';
const clock = buildStubClock(0);
const notices = [];
const booting = bootDaemonClient({ argv: ['false'], readBuild: () => 'atc/test-build' }, {
  waitForDaemonMs: 300,
  clock,
  onWaitForDaemon: () => { notices.push('waiting without starting a daemon'); },
});
const steps = [];
for (let poll = 0; poll < 3; poll++) {
  steps.push(await waitFor(() => {
    const [pending] = clock.collectPending();
    if (pending === undefined) throw new Error('no poll is waiting');
    return pending;
  }));
  clock.advance(100);
}
await booting.catch((error: Error) => {
  process.stdout.write(JSON.stringify({ notices, steps }));
  process.stderr.write(error.message);
  process.exit(3);
});
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  const out = await readJSONRecord(new Response(stdout));

  expect(out['notices']).toStrictEqual(['waiting without starting a daemon']);
  expect(out['steps']).toStrictEqual([100, 100, 100]);
  expect(proc.exitCode).toBe(3);

  expect(stderr).toBe(
    `no atc daemon answered at ${ctx.sockPath} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );

  expect(existsSync(join(ctx.stateDir, 'daemon.lock'))).toBeFalse();
  expect(existsSync(ctx.sockPath)).toBeFalse();
});

test('it rejects when a socket takes the connection but never answers the handshake before the wait ends', async () => {
  const ctx = setupTest();

  startStubUnansweringUnixListener(ctx.sockPath);

  // The socket takes the connection, so the boot waits on the handshake
  // until the stepped clock reaches the end of the wait.
  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
import { buildStubClock } from '${join(import.meta.dir, '..', '..', 'test-utils', 'src', 'build-stub-clock.ts')}';
import { waitFor } from '${join(import.meta.dir, '..', '..', 'test-utils', 'src', 'wait-for.ts')}';
const clock = buildStubClock(0);
const booting = bootDaemonClient({ argv: ['false'], readBuild: () => 'atc/test-build' }, { waitForDaemonMs: 300, clock });
const step = await waitFor(() => {
  const [pending] = clock.collectPending();
  if (pending === undefined) throw new Error('no handshake wait is pending');
  return pending;
});
clock.advance(step);
await booting.catch((error: Error) => {
  process.stdout.write(JSON.stringify({ step }));
  process.stderr.write(error.message);
  process.exit(3);
});
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  expect(stdout).toBe('{"step":300}');
  expect(proc.exitCode).toBe(3);

  expect(stderr).toBe(
    `no atc daemon answered at ${ctx.sockPath} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );
});

test('it reports the start of a wait once across every poll of that wait', async () => {
  const ctx = setupTest();

  // The wait polls every 100 ms of the stepped clock, so a 500 ms wait
  // misses six polls: the probe steps past five of them and the sixth ends
  // the wait.
  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
import { buildStubClock } from '${join(import.meta.dir, '..', '..', 'test-utils', 'src', 'build-stub-clock.ts')}';
import { waitFor } from '${join(import.meta.dir, '..', '..', 'test-utils', 'src', 'wait-for.ts')}';
const clock = buildStubClock(0);
let waits = 0;
const booting = bootDaemonClient({ argv: ['false'], readBuild: () => 'atc/test-build' }, { waitForDaemonMs: 500, clock, onWaitForDaemon: () => { waits += 1; } });
const steps = [];
for (let poll = 0; poll < 5; poll++) {
  steps.push(await waitFor(() => {
    const [pending] = clock.collectPending();
    if (pending === undefined) throw new Error('no poll is waiting');
    return pending;
  }));
  clock.advance(100);
}
const outcome = await booting.then(() => 'booted', (error) => error.message);
process.stdout.write(JSON.stringify({ waits, steps, outcome }));
process.exit(0);
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'ignore',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const stdout = await new Response(proc.stdout).text();

  const out = await readJSONRecord(new Response(stdout));

  expect(out['waits']).toBe(1);
  expect(out['steps']).toStrictEqual([100, 100, 100, 100, 100]);

  expect(out['outcome']).toBe(
    `no atc daemon answered at ${ctx.sockPath} within 0.5s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );
});

test('it rejects with the socket path it is given when a wait finds no daemon there', () => {
  const ctx = setupTest();

  expect(
    bootDaemonClient(
      { argv: ['false'], readBuild: () => 'atc/test-build' },
      {
        waitForDaemonMs: 0,
        paths: {
          socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
          recordFile: join(ctx.dir, 'given', 'daemon.json'),
          pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
        },
      },
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `no atc daemon answered at ${join(ctx.dir, 'given', 'atc-daemon.sock')} within 0s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );
});

test('it rejects at once, saying a boot given its own paths starts no daemon, when none answers there', () => {
  const ctx = setupTest();

  expect(
    bootDaemonClient(
      { argv: ['false'], readBuild: () => 'atc/test-build' },
      {
        paths: {
          socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
          recordFile: join(ctx.dir, 'given', 'daemon.json'),
          pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
        },
      },
    ),
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
    bootDaemonClient(
      { argv: ['false'], readBuild: () => 'atc/test-build' },
      {
        paths: {
          socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
          recordFile: join(ctx.dir, 'given', 'daemon.json'),
          pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
        },
      },
    ),
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
    bootDaemonClient(
      { argv: ['false'], readBuild: () => 'atc/test-build' },
      {
        paths: {
          socketPath: join(ctx.dir, 'given', 'atc-daemon.sock'),
          recordFile: join(ctx.dir, 'given', 'daemon.json'),
          pidFile: join(ctx.dir, 'given', 'atc-daemon.pid'),
        },
      },
    ),
  ).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: expect.toStartWith(
      `the atc daemon (pid 4343, socket ${join(ctx.dir, 'given', 'atc-daemon.sock')}) speaks another protocol than this client`,
    ),
  });
});
