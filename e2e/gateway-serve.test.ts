import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGatewayCommand } from '../src/test-utils/resolve-gateway-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

/**
 * A temp directory to run the gateway in, so a relative path lands there,
 * a free port for a gateway that serves, and the command and environment
 * to run one with: `PATH` and a `HOME` inside the temp directory that
 * nothing creates, so a write under it shows in the directory listing.
 * Disposal removes the directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-gateway-bin-'));

  // The gateway refuses port 0, so a serving gateway takes a port the
  // kernel handed out and released just before.
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = probe.port;

  probe.stop(true);

  const owned = stack.move();

  return {
    dir: tmp.dir,
    port,
    command: resolveGatewayCommand(process.env['ATC_GATEWAY_BIN']),

    // Bun's transpiler cache would write under HOME when the source entry runs.
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: join(tmp.dir, 'home'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    },
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it exits 1 when it has no state directory', () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const result = Bun.spawnSync(
    [
      ...ctx.command,
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(ctx.dir, 'registry.json'),
    ],
    { cwd: ctx.dir, env: { ...ctx.env, ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) } },
  );

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR\n',
  });
});

test('it exits 0 on SIGTERM', async () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  await using gateway = Bun.spawn(
    [
      ...ctx.command,
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(ctx.dir, 'registry.json'),
      '--state-dir',
      join(ctx.dir, 'state'),
      '--port',
      String(ctx.port),
    ],
    {
      cwd: ctx.dir,
      env: { ...ctx.env, ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  // The gateway prints its serving line once its probes answer ready.
  const reader = gateway.stdout.getReader();

  await reader.read();

  reader.releaseLock();
  gateway.kill('SIGTERM');

  const exitCode = await gateway.exited;

  expect(exitCode).toBe(0);
});

test.each([
  { args: ['--state-dir', 'flagged', 'serve'] },
  { args: ['--state-dir=flagged', 'serve'] },
  { args: ['serve', '--state-dir', 'flagged'] },
  { args: ['serve', '--state-dir=flagged'] },
])('it serves from the state directory in $args over the environment', async (row) => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  await using gateway = Bun.spawn(
    [
      ...ctx.command,
      ...row.args,
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      'registry.json',
      '--port',
      String(ctx.port),
    ],
    {
      cwd: ctx.dir,
      env: {
        ...ctx.env,
        ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32),
        ATC_GATEWAY_STATE_DIR: 'from-env',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  // The gateway prints its serving line once its probes answer ready.
  const reader = gateway.stdout.getReader();

  await reader.read();

  reader.releaseLock();

  expect({
    entries: readdirSync(ctx.dir).toSorted(),
    flagged: readdirSync(join(ctx.dir, 'flagged')),
  }).toStrictEqual({
    entries: ['flagged', 'registry.json'],
    flagged: expect.toIncludeAllMembers(['gateway.db', 'mcp-auth.db']),
  });
});
