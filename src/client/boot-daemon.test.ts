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
