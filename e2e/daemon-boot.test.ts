import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootDaemonClient } from '@atc/lifecycle/boot-daemon';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing/build-mock-lifecycle-host';
import { StateStore } from '@atc/store/state-store';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { getSourceEntry } from '@atc/test-utils/get-source-entry';
import { readJSONRecord } from '@atc/test-utils/read-json-record';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { buildHostServices } from '../packages/app/src/build-host-services';
import { startDaemon } from '../packages/app/src/daemon/daemon';

/**
 * A fresh home for a client process: `dir` serves as both its home and its
 * runtime directory, so the client computes `sockPath` as the daemon's
 * socket and `stateDir` as the daemon's state directory. The client reads
 * those paths from its environment, so each test boots it in a subprocess
 * with `env`. `bootModule` is the boot the subprocess imports, and
 * `hostModule` the entry's builder of the host it boots on, from the host
 * services `servicesModule` builds.
 */
function setupTest() {
  const tmp = setupTempDir('atc-daemon-boot-');
  const stateDir = join(tmp.dir, '.local', 'state', 'atc');

  // The daemon and the client both expect the state directory to exist.
  mkdirSync(stateDir, { recursive: true });

  return {
    dir: tmp.dir,
    stateDir,
    sockPath: join(tmp.dir, 'atc-daemon.sock'),
    env: { ...process.env, HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir },
    bootModule: join(import.meta.dir, '..', 'packages', 'lifecycle', 'src', 'boot-daemon.ts'),
    hostModule: join(import.meta.dir, '..', 'packages', 'app', 'src', 'build-lifecycle-host.ts'),
    servicesModule: join(import.meta.dir, '..', 'packages', 'app', 'src', 'build-host-services.ts'),
  };
}

test('it makes a CLI client wait for an installed daemon unit before connecting', async () => {
  const ctx = setupTest();
  const unitDir = join(ctx.dir, '.config', 'systemd', 'user');

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const probe = join(ctx.dir, 'probe.ts');

  // The argv starts nothing, so a boot that tried to start a daemon fails.
  writeFileSync(
    probe,
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { buildHostServices } from '${ctx.servicesModule}';
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, buildHostServices()), invocation });
boot.client.stop();
console.log('connected');
`,
  );

  const proc = Bun.spawn([process.execPath, probe], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const reader = proc.stderr.getReader();

  const message = await reader.read();

  reader.releaseLock();

  const waiting = new TextDecoder().decode(message.value);

  const autostarted = existsSync(join(ctx.stateDir, 'atc.db'));

  const daemon = await startDaemon({
    socketPath: ctx.sockPath,
    reporterSocketPath: join(ctx.dir, 'atc.sock'),
    dbPath: join(ctx.stateDir, 'atc.db'),
    statusPath: join(ctx.stateDir, 'status.json'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
  });

  registerTestCleanup(() => daemon.stop());

  const stdout = await new Response(proc.stdout).text();

  const code = await proc.exited;

  expect(code).toBe(0);
  expect(stdout).toBe('connected\n');
  expect(waiting).toBe('waiting for atc-daemon.service; this client does not start a daemon\n');
  expect(autostarted).toBe(false);
});

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
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { buildHostServices } from '${ctx.servicesModule}';
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, buildHostServices()), invocation });
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
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { buildHostServices } from '${ctx.servicesModule}';
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, buildHostServices()), invocation });
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

test('it stops a daemon on another protocol and boots its own build when the caller confirms the restart', async () => {
  const ctx = setupTest();

  const legacy = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'packages', 'test-utils', 'src', 'run-stub-legacy-daemon.ts'),
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

  // The boot starts the real CLI from source, which runs this tree's build.
  // The probe quits the daemon it booted, so nothing outlives the test.
  writeFileSync(
    join(ctx.dir, 'probe.ts'),
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { buildHostServices } from '${ctx.servicesModule}';
const asked = [];
const invocation = {
  argv: ${JSON.stringify([process.execPath, getSourceEntry('atc')])},
  readBuild: () => ${JSON.stringify(buildHostServices().build)},
};
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, buildHostServices()), invocation }, {
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
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { buildHostServices } from '${ctx.servicesModule}';
let waits = 0;
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, buildHostServices()), invocation }, { waitForDaemonMs: 2000, onWaitForDaemon: () => { waits += 1; } });
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

test('it finds a running daemon through the record at the paths it is given', async () => {
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

  const boot = await bootDaemonClient(buildMockLifecycleHost(), {
    paths: {
      socketPath: join(ctx.dir, 'elsewhere', 'atc-daemon.sock'),
      recordFile: join(ctx.stateDir, 'daemon.json'),
      pidFile: join(ctx.dir, 'elsewhere', 'atc-daemon.pid'),
    },
  });

  registerTestCleanup(() => {
    boot.client.stop();
  });

  expect(boot.socketPath).toBe(join(ctx.dir, 'run', 'atc-daemon.sock'));
});
