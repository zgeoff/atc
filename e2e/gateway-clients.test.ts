import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGatewayCommand, runCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';

function setupTest() {
  const tmp = setupTempDir('atc-gateway-bin-');

  return {
    dir: tmp.path,
    command: resolveGatewayCommand(process.env['ATC_GATEWAY_BIN']),

    // Bun's transpiler cache would write under HOME when the source entry runs.
    env: {
      PATH: process.env['PATH'] ?? '',

      // Nothing creates this home, so a write under it shows in the directory listing.
      HOME: join(tmp.path, 'home'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    },
  };
}

test('it adds, lists, and removes a client in a state directory relative to where it runs over the environment', async () => {
  const ctx = setupTest();

  const added = await runCommand(
    [
      ...ctx.command,
      '--state-dir',
      'flagged',
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
    ],
    { cwd: ctx.dir, env: { ...ctx.env, ATC_GATEWAY_STATE_DIR: 'from-env' } },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout)?.groups?.['id'];

  invariant(clientID !== undefined, `no client ID in: ${added.stdout}${added.stderr}`);

  const listed = await runCommand([...ctx.command, 'clients', 'list', '--state-dir=flagged'], {
    cwd: ctx.dir,
    env: ctx.env,
  });

  expect({ exitCode: listed.exitCode, stdout: listed.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback\n`,
  });

  const removed = await runCommand(
    [...ctx.command, 'clients', 'remove', clientID, '--state-dir', 'flagged'],
    { cwd: ctx.dir, env: ctx.env },
  );

  expect(removed.stdout).toBe(`Removed client ${clientID} and revoked every grant it held\n`);

  const emptied = await runCommand([...ctx.command, 'clients', 'list', '--state-dir=flagged'], {
    cwd: ctx.dir,
    env: ctx.env,
  });

  expect(emptied.stdout).toBe(
    'No clients. Add one with: atc-gateway clients add <name> --redirect-uri <uri>\n',
  );

  expect(readdirSync(ctx.dir).toSorted()).toStrictEqual(['flagged']);
});

test('it exits 1 on two state directories that differ', async () => {
  const ctx = setupTest();

  const added = await runCommand(
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
    stdout: added.stdout,
    stderr: added.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "atc-gateway: --state-dir gives different directories: 'first', 'second'\n",
  });

  expect(readdirSync(ctx.dir)).toStrictEqual([]);
});
