import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { resolveGatewayCommand } from '../src/test-utils/resolve-gateway-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

/**
 * A temp directory to run the gateway in, so a relative path lands there,
 * and the command and environment to run one with: `PATH` and a `HOME`
 * inside the temp directory that nothing creates, so a write under it shows
 * in the directory listing. Disposal removes the directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-gateway-bin-'));
  const owned = stack.move();

  return {
    dir: tmp.dir,
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

test.each([
  { before: ['--state-dir', 'flagged', 'clients', 'add'], after: [] },
  { before: ['--state-dir=flagged', 'clients', 'add'], after: [] },
  { before: ['clients', '--state-dir', 'flagged', 'add'], after: [] },
  { before: ['clients', '--state-dir=flagged', 'add'], after: [] },
  { before: ['clients', 'add'], after: ['--state-dir', 'flagged'] },
  { before: ['clients', 'add'], after: ['--state-dir=flagged'] },
])('it adds a client to the state directory in $before $after over the environment', (row) => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      ...ctx.command,
      ...row.before,
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      ...row.after,
    ],
    { cwd: ctx.dir, env: { ...ctx.env, ATC_GATEWAY_STATE_DIR: 'from-env' } },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout.toString())?.groups?.['id'];

  invariant(
    clientID !== undefined,
    `no client ID in: ${added.stdout.toString()}${added.stderr.toString()}`,
  );

  const listed = Bun.spawnSync([...ctx.command, 'clients', 'list', '--state-dir=flagged'], {
    cwd: ctx.dir,
    env: ctx.env,
  });

  expect({
    listed: listed.stdout.toString(),
    entries: readdirSync(ctx.dir).toSorted(),
  }).toStrictEqual({
    listed: `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback\n`,
    entries: ['flagged'],
  });
});

test.each([
  { args: ['--state-dir', 'flagged', 'clients'] },
  { args: ['--state-dir=flagged', 'clients', 'list'] },
  { args: ['clients', '--state-dir', 'flagged'] },
  { args: ['clients', '--state-dir=flagged', 'list'] },
  { args: ['clients', 'list', '--state-dir', 'flagged'] },
  { args: ['clients', 'list', '--state-dir=flagged'] },
])('it lists the clients in the state directory in $args over the environment', (row) => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      ...ctx.command,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--state-dir=flagged',
    ],
    { cwd: ctx.dir, env: ctx.env },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout.toString())?.groups?.['id'];

  invariant(
    clientID !== undefined,
    `no client ID in: ${added.stdout.toString()}${added.stderr.toString()}`,
  );

  const listed = Bun.spawnSync([...ctx.command, ...row.args], {
    cwd: ctx.dir,
    env: { ...ctx.env, ATC_GATEWAY_STATE_DIR: 'from-env' },
  });

  expect({
    exitCode: listed.exitCode,
    listed: listed.stdout.toString(),
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
])('it removes a client from the state directory in $before $after over the environment', (row) => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      ...ctx.command,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--state-dir=flagged',
    ],
    { cwd: ctx.dir, env: ctx.env },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout.toString())?.groups?.['id'];

  invariant(
    clientID !== undefined,
    `no client ID in: ${added.stdout.toString()}${added.stderr.toString()}`,
  );

  const removed = Bun.spawnSync([...ctx.command, ...row.before, clientID, ...row.after], {
    cwd: ctx.dir,
    env: { ...ctx.env, ATC_GATEWAY_STATE_DIR: 'from-env' },
  });

  const listed = Bun.spawnSync([...ctx.command, 'clients', 'list', '--state-dir=flagged'], {
    cwd: ctx.dir,
    env: ctx.env,
  });

  expect({
    removed: removed.stdout.toString(),
    listed: listed.stdout.toString(),
    entries: readdirSync(ctx.dir).toSorted(),
  }).toStrictEqual({
    removed: `Removed client ${clientID} and revoked every grant it held\n`,
    listed: 'No clients. Add one with: atc-gateway clients add <name> --redirect-uri <uri>\n',
    entries: ['flagged'],
  });
});

test('it exits 1 on two state directories that differ', () => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      ...ctx.command,
      '--state-dir=first',
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--state-dir',
      'second',
    ],
    { cwd: ctx.dir, env: ctx.env },
  );

  expect({
    exitCode: added.exitCode,
    stdout: added.stdout.toString(),
    stderr: added.stderr.toString(),
    entries: readdirSync(ctx.dir),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "atc-gateway: --state-dir gives different directories: 'first', 'second'\n",
    entries: [],
  });
});
