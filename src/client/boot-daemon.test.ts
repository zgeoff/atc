import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '../daemon/daemon';
import { PROTOCOL_V } from '../protocol/protocol';
import { getBuild } from '../shared/get-build';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { readJSONRecord } from '../test-utils/read-json-record';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startStubUnansweringUnixListener } from '../test-utils/start-stub-unanswering-unix-listener';

/**
 * A fresh home for a client process: `dir` serves as both its home and its
 * runtime directory, so the client computes `sockPath` as the daemon's
 * socket and `stateDir` as the daemon's state directory. The client reads
 * those paths once at import, so each test boots it in a subprocess with
 * `env`.
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

test('it reports a codex hello as the last-used agent instead of coercing it to claude', async () => {
  const ctx = setupTest();

  const store = await StateStore.open(join(ctx.dir, 'state.db'));

  registerTestCleanup(() => store.stop());

  await store.writeLastUsedAgent('codex');

  const daemon = await startDaemon({
    socketPath: ctx.sockPath,
    reporterSocketPath: join(ctx.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    dbPath: join(ctx.dir, 'state.db'),
    statusPath: join(ctx.dir, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const boot = await bootDaemonClient();
process.stdout.write(JSON.stringify({ lastUsedAgent: boot.lastUsedAgent }));
boot.client.stop();
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

  expect(JSON.parse(stdout)).toStrictEqual({ lastUsedAgent: 'codex' });
});

test('it finds a running daemon through the state directory when XDG_RUNTIME_DIR is unset', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'run'));

  const daemon = await startDaemon({
    socketPath: join(ctx.dir, 'run', 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'run', 'atc.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    dbPath: join(ctx.stateDir, 'atc.db'),
    statusPath: join(ctx.stateDir, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const boot = await bootDaemonClient();
process.stdout.write(JSON.stringify({ socketPath: boot.socketPath }));
boot.client.stop();
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: { ...ctx.env, XDG_RUNTIME_DIR: undefined },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  expect(JSON.parse(stdout)).toStrictEqual({ socketPath: join(ctx.dir, 'run', 'atc-daemon.sock') });
});

test('it leaves a daemon on another protocol running and rejects with both builds and versions', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
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
const outcome = await bootDaemonClient().then(
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

  expect(legacy.exitCode).toBeNull();
  expect(legacy.signalCode).toBeNull();
  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();

  expect(JSON.parse(stdout)).toStrictEqual({
    code: 'protocol_mismatch',
    message: [
      `the atc daemon (pid ${legacy.pid}, socket ${ctx.sockPath}) speaks another protocol than this client, ${getBuild()} on protocol v${PROTOCOL_V}.`,
      `The daemon answered: ${getBuild()} speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
      'It was left running, so the sessions it hosts keep running.',
      'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.',
    ].join('\n'),
  });
});

test('it stops a daemon on another protocol and boots its own build when the caller confirms the restart', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(async () => {
    legacy.kill('SIGTERM');

    await legacy.exited;
  });

  await legacy.stdout.getReader().read();

  // The probe quits the daemon it booted, so nothing outlives the test.
  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const asked = [];
const boot = await bootDaemonClient({
  onProtocolMismatch: (mismatch) => { asked.push(mismatch.daemonPID); return Promise.resolve(true); },
});
await boot.client.sendRequest('daemon.quit');
boot.client.stop();
process.stdout.write(JSON.stringify({ asked, stale: boot.stale }));
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
  await legacy.exited;

  const out = await readJSONRecord(new Response(stdout));

  expect(out['asked']).toStrictEqual([legacy.pid]);
  expect(out['stale']).toBe(false);
  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it leaves a daemon on another protocol running and rejects when the caller declines the restart', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
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
const outcome = await bootDaemonClient({
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

  expect(legacy.signalCode).toBeNull();
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
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
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
const outcome = await bootDaemonClient({
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

  expect(legacy.signalCode).toBeNull();
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
import { buildStubClock } from '${join(import.meta.dir, '..', 'test-utils', 'build-stub-clock.ts')}';
import { waitFor } from '${join(import.meta.dir, '..', 'test-utils', 'wait-for.ts')}';
const clock = buildStubClock(0);
const notices = [];
const booting = bootDaemonClient({
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
import { buildStubClock } from '${join(import.meta.dir, '..', 'test-utils', 'build-stub-clock.ts')}';
import { waitFor } from '${join(import.meta.dir, '..', 'test-utils', 'wait-for.ts')}';
const clock = buildStubClock(0);
const booting = bootDaemonClient({ waitForDaemonMs: 300, clock });
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
import { buildStubClock } from '${join(import.meta.dir, '..', 'test-utils', 'build-stub-clock.ts')}';
import { waitFor } from '${join(import.meta.dir, '..', 'test-utils', 'wait-for.ts')}';
const clock = buildStubClock(0);
let waits = 0;
const booting = bootDaemonClient({ waitForDaemonMs: 500, clock, onWaitForDaemon: () => { waits += 1; } });
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

test('it never reports a wait when a daemon answers on the first try', async () => {
  const ctx = setupTest();

  const daemon = await startDaemon({
    socketPath: ctx.sockPath,
    reporterSocketPath: join(ctx.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    dbPath: join(ctx.dir, 'state.db'),
    statusPath: join(ctx.dir, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
let waits = 0;
const boot = await bootDaemonClient({ waitForDaemonMs: 2000, onWaitForDaemon: () => { waits += 1; } });
boot.client.stop();
process.stdout.write(JSON.stringify({ waits }));
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

  expect(JSON.parse(stdout)).toStrictEqual({ waits: 0 });
});
