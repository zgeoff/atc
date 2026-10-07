import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGatewayCommand } from './test-utils/resolve-gateway-command';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A temp directory to run the gateway in, so a relative path lands there,
 * a free port for a gateway that serves, and the command and environment
 * to run one with: `PATH` and a `HOME` inside the temp directory that
 * nothing creates, so a write under it shows in the directory listing.
 * `run` runs the gateway in the temp directory to its exit. Disposal kills
 * every gateway `run` started and removes the directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-gateway-bin-'));

  // The gateway refuses port 0, so a serving gateway takes a port the
  // kernel handed out and released just before.
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = probe.port;

  probe.stop(true);

  const command = resolveGatewayCommand(process.env['ATC_GATEWAY_BIN']);

  // Bun's transpiler cache would write under HOME when the source entry runs.
  const env = {
    PATH: process.env['PATH'] ?? '',
    HOME: join(tmp.dir, 'home'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  };

  const owned = stack.move();

  const running = new AsyncDisposableStack();

  return {
    dir: tmp.dir,
    port,
    command,
    env,
    async run(args: readonly string[], extraEnv: Readonly<Record<string, string>>) {
      const proc = running.use(
        Bun.spawn([...command, ...args], {
          cwd: tmp.dir,
          env: { ...env, ...extraEnv },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      return { exitCode, stdout, stderr };
    },
    async [Symbol.asyncDispose]() {
      await running.disposeAsync();

      owned.dispose();
    },
  };
}

test('it answers both probes for the host of its public URL', async () => {
  await using ctx = setupTest();

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

  const health = await fetch(`http://127.0.0.1:${ctx.port}/healthz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  const ready = await fetch(`http://127.0.0.1:${ctx.port}/readyz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  expect([health.status, ready.status]).toStrictEqual([200, 200]);
});

test('it refuses a probe from a foreign host', async () => {
  await using ctx = setupTest();

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

  const health = await fetch(`http://127.0.0.1:${ctx.port}/healthz`, {
    headers: { host: 'evil.example' },
  });

  expect(health.status).toBe(403);
});

test('it keeps both databases in the state directory', async () => {
  await using ctx = setupTest();

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
      '--port',
      String(ctx.port),
    ],
    {
      cwd: ctx.dir,
      env: {
        ...ctx.env,
        ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32),
        ATC_GATEWAY_STATE_DIR: join(ctx.dir, 'state'),
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
    state: readdirSync(join(ctx.dir, 'state')),
    entries: readdirSync(ctx.dir).toSorted(),
  }).toStrictEqual({
    state: expect.toIncludeAllMembers(['gateway.db', 'mcp-auth.db']),
    entries: ['registry.json', 'state'],
  });
});

test('it exits 1 naming the token variable a daemon lacks', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const result = await ctx.run(
    [
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(ctx.dir, 'registry.json'),
      '--state-dir',
      join(ctx.dir, 'state'),
    ],
    {},
  );

  expect({ exitCode: result.exitCode, stderr: result.stderr }).toStrictEqual({
    exitCode: 1,
    stderr: "atc-gateway: daemon 'cloud' has no token: set ATC_GATEWAY_TOKEN_CLOUD\n",
  });
});

test('it exits 1 on a registry that is not JSON', async () => {
  await using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'bad.json'), 'not json');

  const result = await ctx.run(
    [
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(ctx.dir, 'bad.json'),
      '--state-dir',
      join(ctx.dir, 'state'),
    ],
    { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^atc-gateway: cannot read the registry at .*bad\.json: .+\n$/u);
});

test('it exits 1 when it has no state directory', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const result = await ctx.run(
    [
      'serve',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      join(ctx.dir, 'registry.json'),
    ],
    { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
  );

  expect({ exitCode: result.exitCode, stderr: result.stderr }).toStrictEqual({
    exitCode: 1,
    stderr: 'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR\n',
  });
});

test('it exits 0 on SIGTERM', async () => {
  await using ctx = setupTest();

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
  await using ctx = setupTest();

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
    await using ctx = setupTest();

    const added = await ctx.run(
      [
        ...row.before,
        'Claude',
        '--redirect-uri',
        'https://claude.ai/api/mcp/auth_callback',
        ...row.after,
      ],
      { ATC_GATEWAY_STATE_DIR: 'from-env' },
    );

    const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout)?.groups?.['id'];

    if (clientID === undefined) {
      throw new Error(`no client ID in: ${added.stdout}${added.stderr}`);
    }

    const listed = await ctx.run(['clients', 'list', '--state-dir=flagged'], {});

    expect({ listed: listed.stdout, entries: readdirSync(ctx.dir).toSorted() }).toStrictEqual({
      listed: `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback\n`,
      entries: ['flagged'],
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
  await using ctx = setupTest();

  const added = await ctx.run(
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

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout)?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.stdout}${added.stderr}`);
  }

  const listed = await ctx.run(row.args, { ATC_GATEWAY_STATE_DIR: 'from-env' });

  expect({
    exitCode: listed.exitCode,
    listed: listed.stdout,
    entries: readdirSync(ctx.dir).toSorted(),
  }).toStrictEqual({
    exitCode: 0,
    listed: `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback\n`,
    entries: ['flagged'],
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
    await using ctx = setupTest();

    const added = await ctx.run(
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

    const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout)?.groups?.['id'];

    if (clientID === undefined) {
      throw new Error(`no client ID in: ${added.stdout}${added.stderr}`);
    }

    const removed = await ctx.run([...row.before, clientID, ...row.after], {
      ATC_GATEWAY_STATE_DIR: 'from-env',
    });

    const listed = await ctx.run(['clients', 'list', '--state-dir=flagged'], {});

    expect({
      removed: removed.stdout,
      listed: listed.stdout,
      entries: readdirSync(ctx.dir).toSorted(),
    }).toStrictEqual({
      removed: `Removed client ${clientID} and revoked every grant it held\n`,
      listed: 'No clients. Add one with: atc-gateway clients add <name> --redirect-uri <uri>\n',
      entries: ['flagged'],
    });
  },
);

test('it exits 1 on two state directories that differ', async () => {
  await using ctx = setupTest();

  const added = await ctx.run(
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

  expect({ ...added, entries: readdirSync(ctx.dir) }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "atc-gateway: --state-dir gives different directories: 'first', 'second'\n",
    entries: [],
  });
});

test('it exits 1 when a flag takes the state directory flag as its value', async () => {
  await using ctx = setupTest();

  const added = await ctx.run(
    ['clients', 'add', 'Claude', '--redirect-uri', '--state-dir', 'flagged'],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
  );

  expect({ ...added, entries: readdirSync(ctx.dir) }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'atc-gateway: --redirect-uri needs a value; write --redirect-uri=<value>\n',
    entries: [],
  });
});

test('it exits 1 on a flag it does not know at the root', async () => {
  await using ctx = setupTest();

  const added = await ctx.run(
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

  expect({ ...added, entries: readdirSync(ctx.dir) }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "atc-gateway: unknown flag '--stat-dir=flagged'\n",
    entries: [],
  });
});
