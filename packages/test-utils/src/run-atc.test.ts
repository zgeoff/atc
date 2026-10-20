import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveATCCommand } from './resolve-atc-command';
import { runATC } from './run-atc';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-atc-');

  return { directory: temporaryDirectory.path };
}

test('it resolves with the exit code and output of a subcommand', async () => {
  const ctx = setupTest();

  const result = await runATC({
    command: resolveATCCommand(),
    args: ['daemon', 'id'],
    home: ctx.directory,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');

  expect(result.stderr).toInclude(
    `atc daemon id: no daemon at ${join(ctx.directory, 'atc-daemon.sock')}`,
  );
});

test('it lays the run variables over the home', async () => {
  const ctx = setupTest();

  const result = await runATC({
    command: resolveATCCommand(),
    args: ['daemon', 'id'],
    home: ctx.directory,
    env: { XDG_RUNTIME_DIR: join(ctx.directory, 'runtime') },
  });

  expect(result.stderr).toInclude(join(ctx.directory, 'runtime', 'atc-daemon.sock'));
});

test('it removes a variable the run sets to undefined', async () => {
  const ctx = setupTest();

  const result = await runATC({
    command: ['/usr/bin/env'],
    args: [],
    home: ctx.directory,
    env: { XDG_RUNTIME_DIR: undefined },
  });

  expect(result.stdout).toInclude(`HOME=${ctx.directory}\n`);
  expect(result.stdout).not.toInclude('XDG_RUNTIME_DIR=');
});

test('it feeds the run its standard input in the directory it names', async () => {
  const ctx = setupTest();

  const result = await runATC({
    command: ['/bin/sh', '-c', 'pwd; cat'],
    args: [],
    home: ctx.directory,
    stdin: 'from stdin',
    cwd: ctx.directory,
  });

  expect(result.stdout).toBe(`${ctx.directory}\nfrom stdin`);
});
