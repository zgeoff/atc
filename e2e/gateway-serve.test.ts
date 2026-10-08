import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { resolveGatewayCommand } from '../src/test-utils/resolve-gateway-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

/**
 * A temp directory to run the gateway in, so a relative path lands there,
 * a free port for a gateway that serves, and the command and environment
 * to run one with: `PATH` and a `HOME` inside the temp directory that
 * nothing creates, so a write under it shows in the directory listing. The
 * directory goes once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-gateway-bin-');

  // The gateway refuses port 0, so a serving gateway takes a port the
  // kernel handed out and released just before.
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = probe.port;

  probe.stop(true);

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
  };
}

test('it serves from the state directory given before its subcommand over the environment and exits 0 on SIGTERM', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const gateway = Bun.spawn(
    [
      ...ctx.command,
      '--state-dir',
      'flagged',
      'serve',
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

  registerTestCleanup(() => {
    gateway.kill();

    return gateway.exited;
  });

  // The gateway prints its serving line once its probes answer ready.
  const reader = gateway.stdout.getReader();

  const serving = await reader.read();

  reader.releaseLock();

  const ready = await fetch(`http://127.0.0.1:${ctx.port}/readyz`);

  const entries = readdirSync(ctx.dir).toSorted();
  const flagged = readdirSync(join(ctx.dir, 'flagged'));

  gateway.kill('SIGTERM');

  const exitCode = await gateway.exited;

  expect(new TextDecoder().decode(serving.value)).toBe(
    `atc-gateway: serving https://atc.geoff.cloud/mcp, listening on http://127.0.0.1:${ctx.port}\n`,
  );

  expect(ready.status).toBe(200);
  expect(entries).toStrictEqual(['flagged', 'registry.json']);
  expect(flagged).toIncludeAllMembers(['gateway.db', 'mcp-auth.db']);
  expect(exitCode).toBe(0);
});
