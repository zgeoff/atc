import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '../daemon/daemon';
import { PROTOCOL_V } from '../protocol/protocol';
import { getBuild } from '../shared/get-build';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { setupTempDir } from '../test-utils/setup-temp-dir';

/**
 * A fresh home for a client process: `dir` serves as both its home and its
 * runtime directory, so the client computes `sockPath` as the daemon's
 * socket and `stateDir` as the daemon's state directory. The client reads
 * those paths once at import, so each test boots it in a subprocess with
 * `env`. A test defers the release of what it starts to `stack`, so it is
 * released before the directory is removed.
 */
function setupTest() {
  const stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-boot-daemon-'));
  const stateDir = join(tmp.dir, '.local', 'state', 'atc');

  // The daemon and the client both expect the state directory to exist.
  mkdirSync(stateDir, { recursive: true });

  return {
    dir: tmp.dir,
    stateDir,
    sockPath: join(tmp.dir, 'atc-daemon.sock'),
    env: { ...process.env, HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir },
    stack,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

test('it reports a codex hello as the last-used agent instead of coercing it to claude', async () => {
  await using ctx = setupTest();

  const store = await StateStore.open(join(ctx.dir, 'state.db'));

  ctx.stack.defer(() => store.stop());

  await store.writeLastUsedAgent('codex');

  const daemon = await startDaemon({
    socketPath: ctx.sockPath,
    reporterSocketPath: join(ctx.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    dbPath: join(ctx.dir, 'state.db'),
    statusPath: join(ctx.dir, 'status.json'),
  });

  ctx.stack.defer(() => daemon.stop());

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

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  expect(JSON.parse(stdout)).toStrictEqual({ lastUsedAgent: 'codex' });
});

test('it finds a running daemon through the state directory when XDG_RUNTIME_DIR is unset', async () => {
  await using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'run'));

  const daemon = await startDaemon({
    socketPath: join(ctx.dir, 'run', 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'run', 'atc.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    dbPath: join(ctx.stateDir, 'atc.db'),
    statusPath: join(ctx.stateDir, 'status.json'),
  });

  ctx.stack.defer(() => daemon.stop());

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

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const record: unknown = JSON.parse(readFileSync(join(ctx.stateDir, 'daemon.json'), 'utf8'));

  expect(JSON.parse(stdout)).toStrictEqual({ socketPath: join(ctx.dir, 'run', 'atc-daemon.sock') });

  expect(record).toStrictEqual({
    pid: process.pid,
    socketPath: join(ctx.dir, 'run', 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'run', 'atc.sock'),
    eventsSocketPath: null,
    listenPort: null,
  });

  expect(existsSync(join(ctx.stateDir, 'atc-daemon.sock'))).toBeFalse();
});

test('it leaves a daemon on another protocol running and rejects with both builds and versions', async () => {
  await using ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  ctx.stack.defer(async () => {
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
  await using ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  ctx.stack.defer(async () => {
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

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;
  await legacy.exited;

  expect(JSON.parse(stdout)).toStrictEqual({ asked: [legacy.pid], stale: false });
  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it leaves a daemon on another protocol running and rejects when the caller declines the restart', async () => {
  await using ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  ctx.stack.defer(async () => {
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

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  expect(legacy.signalCode).toBeNull();
  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();

  expect(JSON.parse(stdout)).toStrictEqual({
    asked: [legacy.pid],
    outcome: { code: 'protocol_mismatch' },
  });
});

test('it never asks to restart a daemon on another protocol whose pid it cannot find', async () => {
  await using ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'test-utils', 'run-legacy-daemon.ts'),
      ctx.sockPath,
      ctx.stateDir,
    ],
    { env: ctx.env, stdout: 'pipe', stderr: 'inherit' },
  );

  ctx.stack.defer(async () => {
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

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  expect(legacy.signalCode).toBeNull();
  expect(() => process.kill(legacy.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();
  expect(JSON.parse(stdout)).toStrictEqual({ asked: [], outcome: { code: 'protocol_mismatch' } });
});

test('it rejects with the socket it waited on, and starts no daemon, when none answers before the wait ends', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
await bootDaemonClient({ waitForDaemonMs: 300 }).catch((error: Error) => {
  process.stderr.write(error.message);
  process.exit(3);
});
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();

  await proc.exited;

  expect(proc.exitCode).toBe(3);

  expect(stderr).toBe(
    `no atc daemon answered at ${ctx.sockPath} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );

  expect(existsSync(join(ctx.stateDir, 'daemon.lock'))).toBeFalse();
  expect(existsSync(ctx.sockPath)).toBeFalse();
});

test('it rejects when a socket takes the connection but never answers the handshake before the wait ends', async () => {
  await using ctx = setupTest();

  const silent = Bun.listen({ unix: ctx.sockPath, socket: { data: () => {} } });

  ctx.stack.defer(() => {
    silent.stop(true);
  });

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
await bootDaemonClient({ waitForDaemonMs: 300 }).catch((error: Error) => {
  process.stderr.write(error.message);
  process.exit(3);
});
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();

  await proc.exited;

  expect(proc.exitCode).toBe(3);

  expect(stderr).toBe(
    `no atc daemon answered at ${ctx.sockPath} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );
});

test('it reports the start of a wait once across every poll of that wait', async () => {
  await using ctx = setupTest();

  // The wait polls every 100 ms, so half a second holds several polls.
  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
let waits = 0;
await bootDaemonClient({ waitForDaemonMs: 500, onWaitForDaemon: () => { waits += 1; } }).catch(() => {});
process.stdout.write(JSON.stringify({ waits }));
process.exit(0);
`,
  );

  const proc = Bun.spawn([process.execPath, join(ctx.dir, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const stdout = await new Response(proc.stdout).text();

  expect(JSON.parse(stdout)).toStrictEqual({ waits: 1 });
});

test('it never reports a wait when a daemon answers on the first try', async () => {
  await using ctx = setupTest();

  const daemon = await startDaemon({
    socketPath: ctx.sockPath,
    reporterSocketPath: join(ctx.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    dbPath: join(ctx.dir, 'state.db'),
    statusPath: join(ctx.dir, 'status.json'),
  });

  ctx.stack.defer(() => daemon.stop());

  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
let waits = 0;
const boot = await bootDaemonClient({ waitForDaemonMs: 5000, onWaitForDaemon: () => { waits += 1; } });
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

  const stdout = await new Response(proc.stdout).text();

  expect(JSON.parse(stdout)).toStrictEqual({ waits: 0 });
});
