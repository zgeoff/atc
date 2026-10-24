import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import {
  buildStubMessageBridgeHost,
  createStubAppServerCodex,
  createStubBin,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { z } from 'zod';
import { startCodexAppServerBridge } from './start-codex-app-server-bridge';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-codex-app-server-');

  return {
    directory: temporaryDirectory.path,
    bridgeDir: join(temporaryDirectory.path, 'bridge'),
  };
}

test('it stops the App Server and removes its socket when it stops', async () => {
  const ctx = setupTest();
  const bin = createStubAppServerCodex(ctx.directory);

  const bridge = await startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    { bin, planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }) },
  );

  registerTestCleanup(() => bridge.stop());

  await bridge.stop();

  expect(existsSync(join(ctx.bridgeDir, 'codex.sock'))).toBe(false);
});

test('it starts the App Server again when it exits, and the bridge resumes its thread', async () => {
  const ctx = setupTest();
  const codex = createStubAppServerCodex(ctx.directory);

  // Each start records its pid, so the test can end the first server.
  const bin = createStubBin(
    ctx.directory,
    'pid-codex',
    `#!/usr/bin/env bash\necho $$ >> '${join(ctx.directory, 'pids')}'\nexec '${codex}' "$@"\n`,
  );

  const bridge = await startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    {
      bin,
      planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }),
      retryMs: { first: 10, max: 20 },
    },
  );

  registerTestCleanup(() => bridge.stop());

  const first = Number(readFileSync(join(ctx.directory, 'pids'), 'utf8').trim());

  process.kill(first);

  await waitFor(() => {
    expect(readFileSync(join(ctx.directory, 'app-server-requests.jsonl'), 'utf8')).toInclude(
      '"method":"thread/resume"',
    );
  });

  expect(readFileSync(join(ctx.directory, 'pids'), 'utf8').trim().split('\n')).toHaveLength(2);
});

test('it starts the thread and a message sent right after the spawn on the model the spawn asked for', async () => {
  const ctx = setupTest();
  const bin = createStubAppServerCodex(ctx.directory);
  const stub = buildStubMessageBridgeHost();

  const bridge = await startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false, model: 'gpt-test-large' },
      directory: ctx.bridgeDir,
      host: stub.host,
    },
    { bin, planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }) },
  );

  registerTestCleanup(() => bridge.stop());

  bridge.startDelivery();
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'check the build' });

  await waitFor(() => {
    expect(stub.statuses.get('m-1')).toBe('answered');
  });

  const requests = z.array(z.looseObject({ method: z.string(), params: z.unknown() })).parse(
    readFileSync(join(ctx.directory, 'app-server-requests.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line)),
  );

  expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
    model: 'gpt-test-large',
  });

  expect(requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
    clientUserMessageId: 'm-1',
    model: 'gpt-test-large',
  });
});

test('it rejects and leaves no socket when no App Server comes to listen', async () => {
  const ctx = setupTest();
  const bin = createStubBin(ctx.directory, 'dead-codex', '#!/usr/bin/env bash\nexit 1\n');

  const started = startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    { bin, planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }) },
  );

  expect(started).rejects.toMatchObject({ code: -1 });

  await waitFor(() => {
    expect(existsSync(join(ctx.bridgeDir, 'codex.sock'))).toBe(false);
  });
});

test('it ends a server an earlier daemon left running for the session before it starts its own', async () => {
  const ctx = setupTest();
  const bin = createStubAppServerCodex(ctx.directory);
  const socket = join(ctx.bridgeDir, 'codex.sock');

  mkdirSync(ctx.bridgeDir, { recursive: true });

  const orphan = Bun.spawn([bin, 'app-server', '--listen', `unix://${socket}`]);

  registerTestCleanup(() => {
    orphan.kill();
  });

  // Until the child execs, ps shows the test runner's command line, and the
  // bridge leaves alone a pid that runs another command; the socket shows it ran.
  await waitFor(() => {
    expect(existsSync(socket)).toBe(true);
  });

  writeFileSync(join(ctx.bridgeDir, 'app-server.pid'), String(orphan.pid));

  const bridge = await startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    { bin, planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }) },
  );

  registerTestCleanup(() => bridge.stop());

  await expect(orphan.exited).toResolve();
});

test('it kills a server an earlier daemon left running that ignores the stop signal', async () => {
  const ctx = setupTest();
  const bin = createStubAppServerCodex(ctx.directory);
  const socket = join(ctx.bridgeDir, 'codex.sock');

  // An earlier server that never exits on the stop signal. It marks itself
  // ready once it ignores the signal, so no stop reaches it before.
  const stubborn = createStubBin(
    ctx.directory,
    'stubborn-codex',
    `#!/usr/bin/env bash\ntrap '' TERM\ntouch '${join(ctx.directory, 'stubborn-ready')}'\nwhile :; do sleep 0.05; done\n`,
  );

  const orphan = Bun.spawn([stubborn, 'app-server', '--listen', `unix://${socket}`]);

  registerTestCleanup(() => {
    orphan.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.directory, 'stubborn-ready'))).toBe(true);
  });

  mkdirSync(ctx.bridgeDir, { recursive: true });
  writeFileSync(join(ctx.bridgeDir, 'app-server.pid'), String(orphan.pid));

  const bridge = await startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    {
      bin,
      planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }),
      stopGraceMs: 100,
    },
  );

  registerTestCleanup(() => bridge.stop());

  expect(orphan.signalCode).toBe('SIGKILL');
});

test('it leaves alone a process whose pid the system gave out again', async () => {
  const ctx = setupTest();
  const bin = createStubAppServerCodex(ctx.directory);
  const other = Bun.spawn(['tail', '-f', '/dev/null']);

  registerTestCleanup(() => {
    other.kill();
  });

  mkdirSync(ctx.bridgeDir, { recursive: true });
  writeFileSync(join(ctx.bridgeDir, 'app-server.pid'), String(other.pid));

  const bridge = await startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    { bin, planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }) },
  );

  registerTestCleanup(() => bridge.stop());

  expect(other.exitCode).toBeNull();
  expect(other.signalCode).toBeNull();
});

test('it kills a server that ignores the stop signal once the stop grace ends', () => {
  const ctx = setupTest();

  // A server that never listens and ignores the stop signal, so the failed
  // start must kill it outright.
  const bin = createStubBin(
    ctx.directory,
    'stubborn-codex',
    `#!/usr/bin/env bash\ntrap '' TERM\necho $$ > '${join(ctx.directory, 'pid')}'\nwhile :; do sleep 0.05; done\n`,
  );

  const started = startCodexAppServerBridge(
    {
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    {
      bin,
      planTerminal: (remote, thread) => ({ bin, args: [remote, thread] }),
      listenTimeoutMs: 200,
      stopGraceMs: 100,
    },
  );

  expect(started).rejects.toMatchObject({ code: -1 });

  const pid = Number(readFileSync(join(ctx.directory, 'pid'), 'utf8').trim());

  expect(() => process.kill(pid, 0)).toThrow();
});
