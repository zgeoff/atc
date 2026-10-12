import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils/run-command';

test('it passes a gate that leaves the synthetic home alone', async () => {
  const run = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'true',
  ]);

  expect({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }).toStrictEqual({
    exitCode: 0,
    stdout: 'test isolation: 14 canaries unchanged and unread after: true\n',
    stderr: '',
  });
});

test('it fails a gate that reads a canary', async () => {
  const run = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'cat "$HOME/.claude.json" > /dev/null',
  ]);

  expect(run.exitCode).toBe(1);

  expect(run.stderr).toMatch(
    /^test isolation: the gate reached the synthetic live home:\n< \S+\/home\/\.claude\.json [0-9a-f]{64} \d+ \d+\n> \S+\/home\/\.claude\.json [0-9a-f]{64} \d+ \d+\n$/,
  );
});

test('it fails a gate that creates a file in the atc state directory', async () => {
  const run = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'touch "$XDG_STATE_HOME/atc/stray"',
  ]);

  expect(run.exitCode).toBe(1);

  expect(run.stderr).toMatch(
    /^test isolation: the gate reached the synthetic live home:\n> \S+\/home\/\.local\/state\/atc\/stray\n$/,
  );
});

test('it exits with the code of a gate that fails', async () => {
  const run = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'exit 3',
  ]);

  expect({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }).toStrictEqual({
    exitCode: 3,
    stdout: '',
    stderr: '',
  });
});
