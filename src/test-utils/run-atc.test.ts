import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveATCCommand } from './resolve-atc-command';
import { runATC } from './run-atc';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-run-atc-');
}

test('it resolves with the exit code and output of a subcommand', async () => {
  await using ctx = setupTest();

  const result = await runATC({
    command: resolveATCCommand(),
    args: ['daemon', 'id'],
    home: ctx.dir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');

  expect(result.stderr).toInclude(
    `atc daemon id: no daemon at ${join(ctx.dir, 'atc-daemon.sock')}`,
  );
});

test('it lays the run variables over the home', async () => {
  await using ctx = setupTest();

  const result = await runATC({
    command: resolveATCCommand(),
    args: ['daemon', 'id'],
    home: ctx.dir,
    env: { XDG_RUNTIME_DIR: join(ctx.dir, 'runtime') },
  });

  expect(result.stderr).toInclude(join(ctx.dir, 'runtime', 'atc-daemon.sock'));
});

test('it removes a variable the run sets to undefined', async () => {
  await using ctx = setupTest();

  const result = await runATC({
    command: ['/usr/bin/env'],
    args: [],
    home: ctx.dir,
    env: { XDG_RUNTIME_DIR: undefined },
  });

  expect(result.stdout).toInclude(`HOME=${ctx.dir}\n`);
  expect(result.stdout).not.toInclude('XDG_RUNTIME_DIR=');
});

test('it feeds the run its standard input in the directory it names', async () => {
  await using ctx = setupTest();

  const result = await runATC({
    command: ['/bin/sh', '-c', 'pwd; cat'],
    args: [],
    home: ctx.dir,
    stdin: 'from stdin',
    cwd: ctx.dir,
  });

  expect(result.stdout).toBe(`${ctx.dir}\nfrom stdin`);
});
