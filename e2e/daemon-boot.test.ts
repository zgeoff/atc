import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '@atc/daemon';
import { bootDaemonClient } from '@atc/lifecycle';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing';
import { createStateStore } from '@atc/store';
import {
  buildMockAgentAdapter,
  readJSONRecord,
  readSourceEntry,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { createHostServices } from '../packages/app/src/create-host-services';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-daemon-boot-');
  const stateDir = join(temporaryDirectory.path, '.local', 'state', 'atc');

  // The daemon and the client both expect the state directory to exist.
  mkdirSync(stateDir, { recursive: true });

  return {
    directory: temporaryDirectory.path,
    stateDir,
    sockPath: join(temporaryDirectory.path, 'atc-daemon.sock'),

    // The client reads its paths from its environment, so each test boots it in a subprocess.
    env: {
      ...process.env,
      HOME: temporaryDirectory.path,
      XDG_RUNTIME_DIR: temporaryDirectory.path,
    },
    bootModule: join(import.meta.dir, '..', 'packages', 'lifecycle', 'src', 'boot-daemon.ts'),
    hostModule: join(import.meta.dir, '..', 'packages', 'app', 'src', 'build-lifecycle-host.ts'),
    servicesModule: join(
      import.meta.dir,
      '..',
      'packages',
      'app',
      'src',
      'create-host-services.ts',
    ),
  };
}

test('it makes a CLI client wait for an installed daemon unit before connecting', async () => {
  const ctx = setupTest();
  const unitDir = join(ctx.directory, '.config', 'systemd', 'user');

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'atc-daemon.service'), '[Service]\nExecStart=atc daemon\n');

  const probe = join(ctx.directory, 'probe.ts');

  // The argv starts nothing, so a boot that tried to start a daemon fails.
  writeFileSync(
    probe,
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { createHostServices } from '${ctx.servicesModule}';
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, createHostServices()), invocation });
boot.client.stop();
console.log('connected');
`,
  );

  const subprocess = Bun.spawn([process.execPath, probe], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const reader = subprocess.stderr.getReader();

  const message = await reader.read();

  reader.releaseLock();

  const waiting = new TextDecoder().decode(message.value);

  const autostarted = existsSync(join(ctx.stateDir, 'atc.db'));

  const daemon = await startDaemon({
    socketPath: ctx.sockPath,
    reporterSocketPath: join(ctx.directory, 'atc.sock'),
    dbPath: join(ctx.stateDir, 'atc.db'),
    statusPath: join(ctx.stateDir, 'status.json'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    targets: [],
  });

  registerTestCleanup(() => daemon.stop());

  const stdout = await new Response(subprocess.stdout).text();

  const code = await subprocess.exited;

  expect(code).toBe(0);
  expect(stdout).toBe('connected\n');
  expect(waiting).toBe('waiting for atc-daemon.service; this client does not start a daemon\n');
  expect(autostarted).toBe(false);
});

test('it reports a codex hello as the last-used agent instead of coercing it to claude', async () => {
  const ctx = setupTest();

  const store = await createStateStore(join(ctx.directory, 'state.db'));

  registerTestCleanup(() => store.stop());

  await store.writeLastUsedAgent('codex');

  const daemon = await startDaemon({
    socketPath: ctx.sockPath,
    reporterSocketPath: join(ctx.directory, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    targets: [],
    dbPath: join(ctx.directory, 'state.db'),
    statusPath: join(ctx.directory, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  writeFileSync(
    join(ctx.directory, 'probe.ts'),
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { createHostServices } from '${ctx.servicesModule}';
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, createHostServices()), invocation });
process.stdout.write(JSON.stringify({ lastUsedAgent: boot.lastUsedAgent }));
boot.client.stop();
`,
  );

  const subprocess = Bun.spawn([process.execPath, join(ctx.directory, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const stdout = await new Response(subprocess.stdout).text();

  await subprocess.exited;

  expect(JSON.parse(stdout)).toStrictEqual({ lastUsedAgent: 'codex' });
});

test('it finds a running daemon through the state directory when XDG_RUNTIME_DIR is unset', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'run'));

  const daemon = await startDaemon({
    socketPath: join(ctx.directory, 'run', 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.directory, 'run', 'atc.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    targets: [],
    dbPath: join(ctx.stateDir, 'atc.db'),
    statusPath: join(ctx.stateDir, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  writeFileSync(
    join(ctx.directory, 'probe.ts'),
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { createHostServices } from '${ctx.servicesModule}';
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, createHostServices()), invocation });
process.stdout.write(JSON.stringify({ socketPath: boot.socketPath }));
boot.client.stop();
`,
  );

  const subprocess = Bun.spawn([process.execPath, join(ctx.directory, 'probe.ts')], {
    env: { ...ctx.env, XDG_RUNTIME_DIR: undefined },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const stdout = await new Response(subprocess.stdout).text();

  await subprocess.exited;

  expect(JSON.parse(stdout)).toStrictEqual({
    socketPath: join(ctx.directory, 'run', 'atc-daemon.sock'),
  });
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
    join(ctx.directory, 'probe.ts'),
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { createHostServices } from '${ctx.servicesModule}';
const asked = [];
const invocation = {
  argv: ${JSON.stringify([process.execPath, readSourceEntry('atc')])},
  readBuild: () => ${JSON.stringify(createHostServices().build)},
};
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, createHostServices()), invocation }, {
  onProtocolMismatch: (mismatch) => { asked.push(mismatch.daemonPID); return Promise.resolve(true); },
});
await boot.client.sendRequest('daemon.quit');
boot.client.stop();
process.stdout.write(JSON.stringify({ asked, stale: boot.stale }));
process.exit(0);
`,
  );

  const subprocess = Bun.spawn([process.execPath, join(ctx.directory, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const stdout = await new Response(subprocess.stdout).text();

  await subprocess.exited;
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
    reporterSocketPath: join(ctx.directory, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    targets: [],
    dbPath: join(ctx.directory, 'state.db'),
    statusPath: join(ctx.directory, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  writeFileSync(
    join(ctx.directory, 'probe.ts'),
    `import { bootDaemonClient } from '${ctx.bootModule}';
import { buildLifecycleHost } from '${ctx.hostModule}';
import { createHostServices } from '${ctx.servicesModule}';
let waits = 0;
const invocation = { argv: ['false'], readBuild: () => 'atc/test-build' };
const boot = await bootDaemonClient({ ...buildLifecycleHost(process.env, createHostServices()), invocation }, { waitForDaemonMs: 2000, onWaitForDaemon: () => { waits += 1; } });
boot.client.stop();
process.stdout.write(JSON.stringify({ waits }));
process.exit(0);
`,
  );

  const subprocess = Bun.spawn([process.execPath, join(ctx.directory, 'probe.ts')], {
    env: ctx.env,
    stdout: 'pipe',
    stderr: 'ignore',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const stdout = await new Response(subprocess.stdout).text();

  expect(JSON.parse(stdout)).toStrictEqual({ waits: 0 });
});

test('it finds a running daemon through the record at the paths it is given', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'run'));

  const daemon = await startDaemon({
    socketPath: join(ctx.directory, 'run', 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.directory, 'run', 'atc.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    targets: [],
    dbPath: join(ctx.stateDir, 'atc.db'),
    statusPath: join(ctx.stateDir, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  const boot = await bootDaemonClient(buildMockLifecycleHost(), {
    paths: {
      socketPath: join(ctx.directory, 'elsewhere', 'atc-daemon.sock'),
      recordFile: join(ctx.stateDir, 'daemon.json'),
      pidFile: join(ctx.directory, 'elsewhere', 'atc-daemon.pid'),
    },
  });

  registerTestCleanup(() => {
    boot.client.stop();
  });

  expect(boot.socketPath).toBe(join(ctx.directory, 'run', 'atc-daemon.sock'));
});
