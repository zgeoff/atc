import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { startDaemon } from '../daemon/daemon';
import { isRecord } from '../shared/report';
import { StateStore } from '../store/state-store';

const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  takesMessages: false,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

interface FakeDaemonOptions {
  // Whether the daemon writes its record, the only place a client finds
  // its pid in this home.
  readonly record: boolean;
}

/**
 * Starts a daemon on protocol v3 in its own process, under a fresh home
 * whose computed socket path is the daemon's, hosting a session process.
 */
async function setupTest(options: FakeDaemonOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'atc-boot-daemon-'));
  const stateDir = join(dir, '.local', 'state', 'atc');
  const sockPath = join(dir, 'atc-daemon.sock');
  const daemonPath = join(dir, 'daemon.ts');

  mkdirSync(stateDir, { recursive: true });

  const record = JSON.stringify({
    pid: '<pid>',
    socketPath: sockPath,
    reporterSocketPath: join(dir, 'atc.sock'),
    eventsSocketPath: null,
  });

  writeFileSync(
    daemonPath,
    `import { writeFileSync } from 'node:fs';
import { startLegacyDaemon } from '${join(import.meta.dir, '..', '..', 'test', 'start-legacy-daemon.ts')}';
startLegacyDaemon('${sockPath}', { protocol: 3 });
const session = Bun.spawn(['sleep', '60']);
if (${options.record}) {
  writeFileSync('${join(stateDir, 'daemon.json')}', '${record}'.replace('"<pid>"', String(process.pid)));
}
process.stdout.write(JSON.stringify({ sessionPID: session.pid }) + '\\n');
`,
  );

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env['HOME'] = dir;
  env['XDG_RUNTIME_DIR'] = dir;

  const daemon = Bun.spawn([process.execPath, daemonPath], {
    env,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const reader = daemon.stdout.getReader();

  const firstChunk = await reader.read();

  reader.releaseLock();

  const started: unknown = JSON.parse(new TextDecoder().decode(firstChunk.value));

  if (!isRecord(started) || typeof started['sessionPID'] !== 'number') {
    throw new TypeError('the daemon did not report its session');
  }

  const sessionPID = started['sessionPID'];

  return {
    dir,
    sockPath,
    env,
    daemon,
    sessionPID,
    async [Symbol.asyncDispose]() {
      try {
        process.kill(sessionPID, 'SIGKILL');
      } catch {}

      daemon.kill('SIGKILL');

      await daemon.exited;

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it surfaces a codex hello as the last-used agent instead of coercing it to claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-boot-daemon-'));

  // The socket path is derived from XDG_RUNTIME_DIR at import time, so the
  // probe below runs in a subprocess with that variable pointed at this
  // temp dir, rather than importing the client into this process.
  const sockPath = join(dir, 'atc-daemon.sock');

  const store = await StateStore.open(join(dir, 'state.db'));

  await store.writeLastUsedAgent('codex');

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: idleAdapter,
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
  });

  const probePath = join(dir, 'probe.ts');

  writeFileSync(
    probePath,
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const boot = await bootDaemonClient();
process.stdout.write(JSON.stringify({ lastUsedAgent: boot.lastUsedAgent }));
boot.client.stop();
`,
  );

  onTestFinished(async () => {
    await daemon.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env['HOME'] = dir;
  env['XDG_RUNTIME_DIR'] = dir;

  const proc = Bun.spawn([process.execPath, probePath], { env, stdout: 'pipe', stderr: 'pipe' });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const parsed: unknown = JSON.parse(stdout);

  if (!isRecord(parsed)) {
    throw new TypeError('probe did not print an object');
  }

  expect(parsed).toStrictEqual({ lastUsedAgent: 'codex' });
});

test('it finds a running daemon through the state directory when XDG_RUNTIME_DIR is unset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-boot-daemon-'));
  const runDir = join(dir, 'run');
  const stateDir = join(dir, '.local', 'state', 'atc');

  mkdirSync(runDir);
  mkdirSync(stateDir, { recursive: true });

  const daemon = await startDaemon({
    socketPath: join(runDir, 'atc-daemon.sock'),
    reporterSocketPath: join(runDir, 'atc.sock'),
    build: 'atc/test-build',
    adapter: idleAdapter,
    dbPath: join(stateDir, 'atc.db'),
    statusPath: join(stateDir, 'status.json'),
  });

  const probePath = join(dir, 'probe.ts');

  writeFileSync(
    probePath,
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
const boot = await bootDaemonClient();
process.stdout.write(JSON.stringify({ socketPath: boot.socketPath }));
boot.client.stop();
`,
  );

  onTestFinished(async () => {
    await daemon.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'XDG_RUNTIME_DIR') {
      env[key] = value;
    }
  }

  env['HOME'] = dir;

  const proc = Bun.spawn([process.execPath, probePath], { env, stdout: 'pipe', stderr: 'pipe' });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const record: unknown = JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8'));

  expect(JSON.parse(stdout)).toStrictEqual({ socketPath: join(runDir, 'atc-daemon.sock') });
  expect(record).toMatchObject({ pid: process.pid });
  expect(existsSync(join(stateDir, 'atc-daemon.sock'))).toBeFalse();
});

test('it leaves a daemon on another protocol running with its session and rejects with both builds and versions', async () => {
  await using fake = await setupTest({ record: true });

  const probePath = join(fake.dir, 'probe.ts');

  writeFileSync(
    probePath,
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
import { getBuild } from '${join(import.meta.dir, '..', 'shared', 'get-build.ts')}';
const outcome = await bootDaemonClient().then(
  (boot) => { boot.client.stop(); return { booted: true }; },
  (error) => ({ code: error.code, message: error.message }),
);
process.stdout.write(JSON.stringify({ build: getBuild(), outcome }));
process.exit(0);
`,
  );

  const proc = Bun.spawn([process.execPath, probePath], {
    env: fake.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const probed: unknown = JSON.parse(stdout);

  if (!isRecord(probed) || typeof probed['build'] !== 'string') {
    throw new TypeError('probe did not print its build');
  }

  expect(fake.daemon.exitCode).toBeNull();
  expect(fake.daemon.signalCode).toBeNull();
  expect(() => process.kill(fake.daemon.pid, 0)).not.toThrow();
  expect(() => process.kill(fake.sessionPID, 0)).not.toThrow();

  expect(probed['outcome']).toStrictEqual({
    code: 'protocol_mismatch',
    message: [
      `the atc daemon (pid ${fake.daemon.pid}, socket ${fake.sockPath}) speaks another protocol than this client, ${probed['build']} on protocol v4.`,
      `The daemon answered: ${probed['build']} speaks protocol v4, daemon atc/legacy-build speaks v3; restart the daemon so both run the same build`,
      'It was left running, so the sessions it hosts keep running.',
      'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.',
    ].join('\n'),
  });
});

test('it stops a daemon on another protocol and boots its own build when the caller confirms the restart', async () => {
  await using fake = await setupTest({ record: true });

  const probePath = join(fake.dir, 'probe.ts');

  // The probe quits the daemon it booted, so nothing outlives the test.
  writeFileSync(
    probePath,
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

  const proc = Bun.spawn([process.execPath, probePath], {
    env: fake.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  expect(JSON.parse(stdout)).toStrictEqual({ asked: [fake.daemon.pid], stale: false });

  await fake.daemon.exited;

  expect(fake.daemon.signalCode).toBe('SIGTERM');
});

test('it leaves a daemon on another protocol running and rejects when the caller declines the restart', async () => {
  await using fake = await setupTest({ record: true });

  const probePath = join(fake.dir, 'probe.ts');

  writeFileSync(
    probePath,
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

  const proc = Bun.spawn([process.execPath, probePath], {
    env: fake.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  expect(fake.daemon.signalCode).toBeNull();
  expect(() => process.kill(fake.daemon.pid, 0)).not.toThrow();
  expect(() => process.kill(fake.sessionPID, 0)).not.toThrow();

  expect(JSON.parse(stdout)).toStrictEqual({
    asked: [fake.daemon.pid],
    outcome: { code: 'protocol_mismatch' },
  });
});

test('it never asks to restart a daemon on another protocol whose pid it cannot find', async () => {
  await using fake = await setupTest({ record: false });

  const probePath = join(fake.dir, 'probe.ts');

  writeFileSync(
    probePath,
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

  const proc = Bun.spawn([process.execPath, probePath], {
    env: fake.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  expect(fake.daemon.signalCode).toBeNull();
  expect(() => process.kill(fake.daemon.pid, 0)).not.toThrow();
  expect(JSON.parse(stdout)).toStrictEqual({ asked: [], outcome: { code: 'protocol_mismatch' } });
});

test('it rejects with the socket it waited on, and starts no daemon, when none answers before the wait ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-boot-daemon-'));
  const probePath = join(dir, 'probe.ts');

  writeFileSync(
    probePath,
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
await bootDaemonClient({ waitForDaemonMs: 300 }).catch((error: Error) => {
  process.stderr.write(error.message);
  process.exit(3);
});
`,
  );

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env['HOME'] = dir;
  env['XDG_RUNTIME_DIR'] = dir;

  const proc = Bun.spawn([process.execPath, probePath], { env, stdout: 'ignore', stderr: 'pipe' });

  const stderr = await new Response(proc.stderr).text();

  await proc.exited;

  // No signal marks a daemon that was never started, so this gives a
  // spawned one far longer than it needs to take the state lock.
  await Bun.sleep(1000);

  expect(proc.exitCode).toBe(3);

  expect(stderr).toBe(
    `no atc daemon answered at ${join(dir, 'atc-daemon.sock')} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );

  expect(existsSync(join(dir, '.local', 'state', 'atc', 'daemon.lock'))).toBeFalse();
  expect(existsSync(join(dir, 'atc-daemon.sock'))).toBeFalse();
});

test('it rejects when a socket takes the connection but never answers the handshake before the wait ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-boot-daemon-'));
  const probePath = join(dir, 'probe.ts');
  const silent = Bun.listen({ unix: join(dir, 'atc-daemon.sock'), socket: { data: () => {} } });

  writeFileSync(
    probePath,
    `import { bootDaemonClient } from '${join(import.meta.dir, 'boot-daemon.ts')}';
await bootDaemonClient({ waitForDaemonMs: 300 }).catch((error: Error) => {
  process.stderr.write(error.message);
  process.exit(3);
});
`,
  );

  onTestFinished(() => {
    silent.stop(true);

    rmSync(dir, { recursive: true, force: true });
  });

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env['HOME'] = dir;
  env['XDG_RUNTIME_DIR'] = dir;

  const started = Date.now();
  const proc = Bun.spawn([process.execPath, probePath], { env, stdout: 'ignore', stderr: 'pipe' });

  const stderr = await new Response(proc.stderr).text();

  await proc.exited;

  expect(proc.exitCode).toBe(3);

  expect(stderr).toBe(
    `no atc daemon answered at ${join(dir, 'atc-daemon.sock')} within 0.3s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`,
  );

  expect(Date.now() - started).toBeLessThan(5000);
});
