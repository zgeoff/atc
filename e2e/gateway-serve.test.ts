import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, resolveGatewayCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-gateway-bin-');

  return {
    directory: temporaryDirectory.path,
    command: resolveGatewayCommand(process.env['ATC_GATEWAY_BIN']),

    // Bun's transpiler cache would write under HOME when the source entry runs.
    env: {
      PATH: process.env['PATH'] ?? '',

      // Nothing creates this home, so a write under it shows in the directory listing.
      HOME: join(temporaryDirectory.path, 'home'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    },
  };
}

test('it serves from the state directory given before its subcommand over the environment and exits 0 on SIGTERM', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
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
      'https://atc.example.com',
      '--registry',
      'registry.json',
      '--port',
      '0',
    ],
    {
      cwd: ctx.directory,
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

  // The gateway prints its serving line once its probes answer ready, with
  // the port the kernel bound for port 0.
  const reader = gateway.stdout.getReader();

  const chunk = await reader.read();

  reader.releaseLock();

  const serving = new TextDecoder().decode(chunk.value);

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)\n$/u.exec(serving)?.groups?.[
    'port'
  ];

  invariant(port !== undefined, `no bound port in the serving line: ${serving}`);

  const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

  const entries = readdirSync(ctx.directory).toSorted();
  const flagged = readdirSync(join(ctx.directory, 'flagged'));

  gateway.kill('SIGTERM');

  const exitCode = await gateway.exited;

  expect(serving).toBe(
    `atc-gateway: serving https://atc.example.com/mcp, listening on http://127.0.0.1:${port}\n`,
  );

  expect(Number(port)).toBeGreaterThan(0);
  expect(ready.status).toBe(200);
  expect(entries).toStrictEqual(['flagged', 'registry.json']);
  expect(flagged).toIncludeAllMembers(['gateway.db', 'mcp-auth.db']);
  expect(exitCode).toBe(0);
});
