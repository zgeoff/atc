import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from './agent-adapter';
import { startDaemon } from './daemon';
import { isRecord } from './report';
import { StateStore } from './state-store';

const idleAdapter: AgentAdapter = {
  kind: 'claude',
  headlessRunner: null,
  screenDetector: null,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

test('it surfaces a codex hello as the last-used agent instead of coercing it to claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-boot-daemon-'));

  // bootDaemonClient reads its socket path from config.ts constants, which
  // are derived from XDG_RUNTIME_DIR at import time — so the probe below
  // runs in a subprocess with that env var pointed at this temp dir, rather
  // than importing boot-daemon into this process.
  const sockPath = join(dir, 'atc-daemon.sock');

  const store = new StateStore(join(dir, 'state.db'));

  store.writeLastUsedAgent('codex');

  const daemon = startDaemon({
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

  onTestFinished(() => {
    daemon.stop();

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
