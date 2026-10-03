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
  const dir = mkdtempSync(join(tmpdir(), 'atc-boot-daemon-'));
  const stateDir = join(dir, '.local', 'state', 'atc');
  const sockPath = join(dir, 'atc-daemon.sock');

  mkdirSync(stateDir, { recursive: true });

  // The daemon runs in its own process with its own pid, recorded where a
  // client looks for the daemon to stop, and hosts a session process.
  const daemonPath = join(dir, 'daemon.ts');

  writeFileSync(
    daemonPath,
    `import { writeFileSync } from 'node:fs';
import { startLegacyDaemon } from '${join(import.meta.dir, '..', '..', 'test', 'start-legacy-daemon.ts')}';
startLegacyDaemon('${sockPath}', { protocol: 3 });
const session = Bun.spawn(['sleep', '60']);
writeFileSync('${join(stateDir, 'daemon.json')}', JSON.stringify({ pid: process.pid, socketPath: '${sockPath}', reporterSocketPath: '${join(dir, 'atc.sock')}', eventsSocketPath: null }));
process.stdout.write(JSON.stringify({ sessionPID: session.pid }) + '\\n');
`,
  );

  const probePath = join(dir, 'probe.ts');

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

  onTestFinished(() => {
    process.kill(sessionPID, 'SIGKILL');
    daemon.kill('SIGKILL');

    rmSync(dir, { recursive: true, force: true });
  });

  const proc = Bun.spawn([process.execPath, probePath], { env, stdout: 'pipe', stderr: 'pipe' });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const probed: unknown = JSON.parse(stdout);

  if (!isRecord(probed) || typeof probed['build'] !== 'string') {
    throw new TypeError('probe did not print its build');
  }

  expect(daemon.exitCode).toBeNull();
  expect(daemon.signalCode).toBeNull();
  expect(() => process.kill(daemon.pid, 0)).not.toThrow();
  expect(() => process.kill(sessionPID, 0)).not.toThrow();

  expect(probed['outcome']).toStrictEqual({
    code: 'protocol_mismatch',
    message: [
      `the atc daemon (pid ${daemon.pid}, socket ${sockPath}) speaks another protocol than this client, ${probed['build']} on protocol v4.`,
      `The daemon answered: ${probed['build']} speaks protocol v4, daemon atc/legacy-build speaks v3; restart the daemon so both run the same build`,
      'It was left running, so the sessions it hosts keep running.',
      'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.',
    ].join('\n'),
  });
});
