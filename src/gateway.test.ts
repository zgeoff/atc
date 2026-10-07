import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { waitFor } from './test-utils/wait-for';

// The command every test runs the gateway as: the source entry under the
// test's own bun, or the compiled binary a smoke run points ATC_GATEWAY_BIN
// at, so one suite proves both.
const gatewayCommand =
  process.env['ATC_GATEWAY_BIN'] === undefined
    ? [process.execPath, join(import.meta.dir, 'gateway.ts')]
    : [process.env['ATC_GATEWAY_BIN']];

/**
 * A temp directory holding a registry file whose one daemon, `cloud`, has
 * an address nothing listens on, and a free port for the gateway. `env`
 * holds `PATH` and a `HOME` inside the temp directory that nothing creates,
 * so a write under it shows in the directory listing. `run` and `start` run
 * the gateway in the temp directory, so a relative path lands there. `start`
 * appends the free port to its arguments and waits until the readiness
 * probe returns 200; disposal kills it and removes the directory.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-gateway-bin-');

  writeFileSync(
    join(tmp.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = probe.port ?? 0;

  await probe.stop(true);

  // Bun's transpiler cache would write under HOME when the source entry runs.
  const env = {
    PATH: process.env['PATH'] ?? '',
    HOME: join(tmp.dir, 'home'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  };

  const running: Bun.Subprocess[] = [];

  return {
    dir: tmp.dir,
    port,
    env,
    run(args: readonly string[], extraEnv: Readonly<Record<string, string>>) {
      const result = Bun.spawnSync([...gatewayCommand, ...args], {
        cwd: tmp.dir,
        env: { ...env, ...extraEnv },
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
    async start(args: readonly string[], extraEnv: Readonly<Record<string, string>>) {
      const proc = Bun.spawn([...gatewayCommand, ...args, '--port', String(port)], {
        cwd: tmp.dir,
        env: { ...env, ...extraEnv },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      running.push(proc);

      await waitFor(
        async () => {
          const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

          if (ready.status !== 200) {
            throw new Error(`readyz returned ${ready.status}`);
          }
        },
        { timeoutMs: 15_000 },
      );

      return proc;
    },
    async [Symbol.asyncDispose]() {
      for (const proc of running) {
        proc.kill();

        await proc.exited;
      }

      tmp[Symbol.dispose]();
    },
  };
}

test('it answers both probes for the host of its public URL', async () => {
  await using gateway = await setupTest();

  await gateway.start(
    [
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(gateway.dir, 'registry.json'),
      '--state-dir',
      join(gateway.dir, 'state'),
    ],
    { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
  );

  const health = await fetch(`http://127.0.0.1:${gateway.port}/healthz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  const ready = await fetch(`http://127.0.0.1:${gateway.port}/readyz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  expect([health.status, ready.status]).toStrictEqual([200, 200]);
});

test('it refuses a probe from a foreign host', async () => {
  await using gateway = await setupTest();

  await gateway.start(
    [
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(gateway.dir, 'registry.json'),
      '--state-dir',
      join(gateway.dir, 'state'),
    ],
    { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
  );

  const health = await fetch(`http://127.0.0.1:${gateway.port}/healthz`, {
    headers: { host: 'evil.example' },
  });

  expect(health.status).toBe(403);
});

test('it keeps both databases in the state directory', async () => {
  await using gateway = await setupTest();

  await gateway.start(
    [
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(gateway.dir, 'registry.json'),
    ],
    { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32), ATC_GATEWAY_STATE_DIR: join(gateway.dir, 'state') },
  );

  expect(readdirSync(join(gateway.dir, 'state'))).toIncludeAllMembers([
    'gateway.db',
    'mcp-auth.db',
  ]);

  expect(readdirSync(gateway.dir).toSorted()).toStrictEqual(['registry.json', 'state']);
});

test('it exits 1 naming the token variable a daemon lacks', async () => {
  await using gateway = await setupTest();

  const proc = Bun.spawn(
    [
      ...gatewayCommand,
      'serve',
      '--port',
      String(gateway.port),
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(gateway.dir, 'registry.json'),
      '--state-dir',
      join(gateway.dir, 'state'),
    ],
    { env: gateway.env, stdout: 'pipe', stderr: 'pipe' },
  );

  const exitCode = await proc.exited;

  const stderr = await new Response(proc.stderr).text();

  expect({ exitCode, stderr }).toStrictEqual({
    exitCode: 1,
    stderr: "atc-gateway: daemon 'cloud' has no token: set ATC_GATEWAY_TOKEN_CLOUD\n",
  });
});

test('it exits 1 on a registry that is not JSON', async () => {
  await using gateway = await setupTest();

  writeFileSync(join(gateway.dir, 'bad.json'), 'not json');

  const proc = Bun.spawn(
    [
      ...gatewayCommand,
      'serve',
      '--port',
      String(gateway.port),
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(gateway.dir, 'bad.json'),
      '--state-dir',
      join(gateway.dir, 'state'),
    ],
    {
      env: { ...gateway.env, ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const exitCode = await proc.exited;

  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).toBe(1);
  expect(stderr).toMatch(/^atc-gateway: cannot read the registry at .*bad\.json: .+\n$/);
});

test('it exits 1 when it has no state directory', async () => {
  await using gateway = await setupTest();

  const proc = Bun.spawn(
    [
      ...gatewayCommand,
      'serve',
      '--port',
      String(gateway.port),
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(gateway.dir, 'registry.json'),
    ],
    {
      env: { ...gateway.env, ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const exitCode = await proc.exited;

  const stderr = await new Response(proc.stderr).text();

  expect({ exitCode, stderr }).toStrictEqual({
    exitCode: 1,
    stderr: 'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR\n',
  });
});

test('it exits 0 on SIGTERM', async () => {
  await using gateway = await setupTest();

  const proc = await gateway.start(
    [
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(gateway.dir, 'registry.json'),
      '--state-dir',
      join(gateway.dir, 'state'),
    ],
    { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
  );

  proc.kill('SIGTERM');

  const exitCode = await proc.exited;

  expect(exitCode).toBe(0);
});

test.each([
  { args: ['--state-dir', 'flagged', 'serve'] },
  { args: ['--state-dir=flagged', 'serve'] },
  { args: ['serve', '--state-dir', 'flagged'] },
  { args: ['serve', '--state-dir=flagged'] },
])('it serves from the state directory in $args over the environment', async (row) => {
  await using gateway = await setupTest();

  await gateway.start(
    [...row.args, '--public-url', 'https://atc.geoff.cloud', '--registry', 'registry.json'],
    { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32), ATC_GATEWAY_STATE_DIR: 'from-env' },
  );

  expect(readdirSync(gateway.dir).toSorted()).toStrictEqual(['flagged', 'registry.json']);

  expect(readdirSync(join(gateway.dir, 'flagged'))).toIncludeAllMembers([
    'gateway.db',
    'mcp-auth.db',
  ]);
});

test.each([
  { before: ['--state-dir', 'flagged', 'clients', 'add'], after: [] },
  { before: ['--state-dir=flagged', 'clients', 'add'], after: [] },
  { before: ['clients', '--state-dir', 'flagged', 'add'], after: [] },
  { before: ['clients', '--state-dir=flagged', 'add'], after: [] },
  { before: ['clients', 'add'], after: ['--state-dir', 'flagged'] },
  { before: ['clients', 'add'], after: ['--state-dir=flagged'] },
])(
  'it adds a client to the state directory in $before $after over the environment',
  async (row) => {
    await using gateway = await setupTest();

    const added = gateway.run(
      [
        ...row.before,
        'Claude',
        '--redirect-uri',
        'https://claude.ai/api/mcp/auth_callback',
        ...row.after,
      ],
      { ATC_GATEWAY_STATE_DIR: 'from-env' },
    );

    const listed = gateway.run(['clients', 'list', '--state-dir=flagged'], {});
    const clientID = /client ID is (?<id>\w+)/.exec(added.stdout)?.groups?.['id'];

    if (clientID === undefined) {
      throw new Error(`no client ID in: ${added.stdout}${added.stderr}`);
    }

    expect({ listed: listed.stdout, entries: readdirSync(gateway.dir).toSorted() }).toStrictEqual({
      listed: `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback\n`,
      entries: ['flagged', 'registry.json'],
    });
  },
);

test.each([
  { args: ['--state-dir', 'flagged', 'clients'] },
  { args: ['--state-dir=flagged', 'clients', 'list'] },
  { args: ['clients', '--state-dir', 'flagged'] },
  { args: ['clients', '--state-dir=flagged', 'list'] },
  { args: ['clients', 'list', '--state-dir', 'flagged'] },
  { args: ['clients', 'list', '--state-dir=flagged'] },
])('it lists the clients in the state directory in $args over the environment', async (row) => {
  await using gateway = await setupTest();

  const added = gateway.run(
    [
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--state-dir=flagged',
    ],
    {},
  );

  const listed = gateway.run(row.args, { ATC_GATEWAY_STATE_DIR: 'from-env' });
  const clientID = /client ID is (?<id>\w+)/.exec(added.stdout)?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.stdout}${added.stderr}`);
  }

  expect({
    exitCode: listed.exitCode,
    listed: listed.stdout,
    entries: readdirSync(gateway.dir).toSorted(),
  }).toStrictEqual({
    exitCode: 0,
    listed: `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback\n`,
    entries: ['flagged', 'registry.json'],
  });
});

test.each([
  { before: ['--state-dir', 'flagged', 'clients', 'remove'], after: [] },
  { before: ['--state-dir=flagged', 'clients', 'remove'], after: [] },
  { before: ['clients', '--state-dir', 'flagged', 'remove'], after: [] },
  { before: ['clients', '--state-dir=flagged', 'remove'], after: [] },
  { before: ['clients', 'remove'], after: ['--state-dir', 'flagged'] },
  { before: ['clients', 'remove'], after: ['--state-dir=flagged'] },
])(
  'it removes a client from the state directory in $before $after over the environment',
  async (row) => {
    await using gateway = await setupTest();

    const added = gateway.run(
      [
        'clients',
        'add',
        'Claude',
        '--redirect-uri',
        'https://claude.ai/api/mcp/auth_callback',
        '--state-dir=flagged',
      ],
      {},
    );

    const clientID = /client ID is (?<id>\w+)/.exec(added.stdout)?.groups?.['id'];

    if (clientID === undefined) {
      throw new Error(`no client ID in: ${added.stdout}${added.stderr}`);
    }

    const removed = gateway.run([...row.before, clientID, ...row.after], {
      ATC_GATEWAY_STATE_DIR: 'from-env',
    });

    const listed = gateway.run(['clients', 'list', '--state-dir=flagged'], {});

    expect({
      removed: removed.stdout,
      listed: listed.stdout,
      entries: readdirSync(gateway.dir).toSorted(),
    }).toStrictEqual({
      removed: `Removed client ${clientID} and revoked every grant it held\n`,
      listed: 'No clients. Add one with: atc-gateway clients add <name> --redirect-uri <uri>\n',
      entries: ['flagged', 'registry.json'],
    });
  },
);

test('it exits 1 on two state directories that differ', async () => {
  await using gateway = await setupTest();

  const added = gateway.run(
    [
      '--state-dir=first',
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--state-dir',
      'second',
    ],
    {},
  );

  expect({ ...added, entries: readdirSync(gateway.dir) }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "atc-gateway: --state-dir gives different directories: 'first', 'second'\n",
    entries: ['registry.json'],
  });
});

test('it exits 1 when a flag takes the state directory flag as its value', async () => {
  await using gateway = await setupTest();

  const added = gateway.run(
    ['clients', 'add', 'Claude', '--redirect-uri', '--state-dir', 'flagged'],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
  );

  expect({ ...added, entries: readdirSync(gateway.dir) }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'atc-gateway: --redirect-uri needs a value; write --redirect-uri=<value>\n',
    entries: ['registry.json'],
  });
});

test('it exits 1 on a flag it does not know at the root', async () => {
  await using gateway = await setupTest();

  const added = gateway.run(
    [
      '--stat-dir=flagged',
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
    ],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
  );

  expect({ ...added, entries: readdirSync(gateway.dir) }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "atc-gateway: unknown flag '--stat-dir=flagged'\n",
    entries: ['registry.json'],
  });
});
