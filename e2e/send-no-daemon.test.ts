import { expect, test } from 'bun:test';
import { runATC } from '@atc/app/test-utils/run-atc';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-send-no-daemon-');

  return { directory: temporaryDirectory.path };
}

test('it exits 4 within 10 s and starts no daemon when atc send finds none', async () => {
  const ctx = setupTest();
  const startedAtMs = Date.now();

  const ran = await runATC({
    command: resolveATCCommand(),
    args: ['send', 'planner', 'hello', '--key', 'k-1', '--json'],
    home: ctx.directory,
  });

  const stdout: unknown = JSON.parse(ran.stdout);

  expect({ code: ran.exitCode, stdout, stderr: ran.stderr }).toStrictEqual({
    code: 4,
    stdout: { key: 'k-1', error: { code: 'unreachable', message: expect.any(String) } },
    stderr: '',
  });

  expect(Date.now() - startedAtMs).toBeLessThan(10_000);
});

test('it exits 4 when atc message get finds no daemon', async () => {
  const ctx = setupTest();

  const ran = await runATC({
    command: resolveATCCommand(),
    args: ['message', 'get', 'm-1'],
    home: ctx.directory,
  });

  expect({ code: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }).toStrictEqual({
    code: 4,
    stdout: '',
    stderr: expect.toStartWith('atc message get: unreachable: '),
  });
});

test('it exits 2 with the usage on stderr alone when atc send takes a flag it refuses', async () => {
  const ctx = setupTest();

  const ran = await runATC({
    command: resolveATCCommand(),
    args: ['send', 'planner', 'hello', '--json', '--timeout', '5'],
    home: ctx.directory,
  });

  expect({ code: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }).toStrictEqual({
    code: 2,
    stdout: '',
    stderr: expect.toInclude('--timeout needs --wait'),
  });
});
