import { expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils/run-command';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { buildHomeRelativeCommand } from './build-home-relative-command';

/**
 * A temp directory that stands in for the guest's home.
 */
function setupTest() {
  const tmp = setupTempDir('atc-home-relative-command-');

  return { home: realpathSync(tmp.dir) };
}

test('it passes a command with an absolute directory through as it stands', () => {
  expect(buildHomeRelativeCommand(['pwd'], '/srv/orchard')).toStrictEqual({
    argv: ['pwd'],
    cwd: '/srv/orchard',
  });
});

test('it starts a command with a relative directory from the root', () => {
  expect(buildHomeRelativeCommand(['pwd'], 'orchard').cwd).toBe('/');
});

test('it runs a command with a relative directory in that directory under the home, with its arguments whole', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'orchard', 'pears'), { recursive: true });

  const command = buildHomeRelativeCommand(
    ['sh', '-c', 'pwd -P; printf "%s|" "$@"', 'sh', 'a b', ''],
    'orchard/pears',
  );

  const result = await runCommand(command.argv, {
    cwd: command.cwd,
    env: { HOME: ctx.home, PATH: process.env['PATH'] },
  });

  expect(result).toStrictEqual({
    exitCode: 0,
    signalCode: null,
    stdout: `${join(ctx.home, 'orchard', 'pears')}\na b||`,
    stderr: '',
  });
});

test('it follows a parent step from where a symlink under the home leads, as a start in it does', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'far', 'grove'), { recursive: true });
  symlinkSync(join(ctx.home, 'far', 'grove'), join(ctx.home, 'link'));

  const command = buildHomeRelativeCommand(['pwd', '-P'], 'link/..');

  const result = await runCommand(command.argv, {
    cwd: command.cwd,
    env: { HOME: ctx.home, PATH: process.env['PATH'] },
  });

  expect(result.stdout).toBe(`${join(ctx.home, 'far')}\n`);
});

test('it fails a command whose relative directory is missing under the home, without running it', async () => {
  const ctx = setupTest();
  const command = buildHomeRelativeCommand(['sh', '-c', 'echo ran'], 'missing');

  const result = await runCommand(command.argv, {
    cwd: command.cwd,
    env: { HOME: ctx.home, PATH: process.env['PATH'] },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout }).toStrictEqual({
    exitCode: expect.toBeOneOf([1, 2]),
    stdout: '',
  });
});
