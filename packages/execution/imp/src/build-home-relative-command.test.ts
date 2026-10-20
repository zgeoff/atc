import { expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';
import { buildHomeRelativeCommand } from './build-home-relative-command';

function setupTest() {
  const tmp = setupTempDir('atc-home-relative-command-');

  return { home: realpathSync(tmp.path) };
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

test('it runs a command with a relative directory named - in that directory under the home, not the previous one', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '-'));

  const command = buildHomeRelativeCommand(['pwd', '-P'], '-');

  const result = await runCommand(command.argv, {
    cwd: command.cwd,
    env: { HOME: ctx.home, PATH: process.env['PATH'] },
  });

  expect(result).toStrictEqual({
    exitCode: 0,
    signalCode: null,
    stdout: `${join(ctx.home, '-')}\n`,
    stderr: '',
  });
});

test('it runs a command with a relative directory under the home when a CDPATH entry holds one of the same name', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'orchard'));
  mkdirSync(join(ctx.home, 'elsewhere', 'orchard'), { recursive: true });

  const command = buildHomeRelativeCommand(['pwd', '-P'], 'orchard');

  const result = await runCommand(command.argv, {
    cwd: command.cwd,
    env: { HOME: ctx.home, PATH: process.env['PATH'], CDPATH: join(ctx.home, 'elsewhere') },
  });

  expect(result).toStrictEqual({
    exitCode: 0,
    signalCode: null,
    stdout: `${join(ctx.home, 'orchard')}\n`,
    stderr: '',
  });
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
