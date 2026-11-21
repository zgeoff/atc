import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { run } from '@zgeoff/testing/process';

test('it passes a gate that leaves the synthetic home alone', async () => {
  const result = await run([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'true',
  ]);

  expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
    {
      exitCode: 0,
      stdout: 'test isolation: 14 canaries unchanged and unread after: true\n',
      stderr: '',
    },
  );
});

test("it points a gate's mise at the host's own XDG homes", async () => {
  const result = await run(
    [
      process.execPath,
      join(import.meta.dir, 'check-test-isolation.ts'),
      'sh',
      '-c',
      'echo "$MISE_CONFIG_DIR $MISE_DATA_DIR $MISE_STATE_DIR $MISE_CACHE_DIR"',
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((name) => name.startsWith('MISE_'))
            .map((name) => [name, undefined]),
        ),
        XDG_CONFIG_HOME: '/srv/orchard/config',
        XDG_DATA_HOME: '/srv/orchard/data',
        XDG_STATE_HOME: '/srv/orchard/state',
        XDG_CACHE_HOME: '/srv/orchard/cache',
      },
    },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout }).toStrictEqual({
    exitCode: 0,
    stdout:
      '/srv/orchard/config/mise /srv/orchard/data/mise /srv/orchard/state/mise /srv/orchard/cache/mise\n' +
      'test isolation: 14 canaries unchanged and unread after: sh -c echo "$MISE_CONFIG_DIR $MISE_DATA_DIR $MISE_STATE_DIR $MISE_CACHE_DIR"\n',
  });
});

test('it fails a gate that reads a canary', async () => {
  const result = await run([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'cat "$HOME/.claude.json" > /dev/null',
  ]);

  expect(result.exitCode).toBe(1);

  expect(result.stderr).toMatch(
    /^test isolation: the gate reached the synthetic live home:\n< \S+\/home\/\.claude\.json [0-9a-f]{64} \d+ \d+\n> \S+\/home\/\.claude\.json [0-9a-f]{64} \d+ \d+\n$/u,
  );
});

test('it fails a gate that creates a file in the atc state directory', async () => {
  const result = await run([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'touch "$XDG_STATE_HOME/atc/stray"',
  ]);

  expect(result.exitCode).toBe(1);

  expect(result.stderr).toMatch(
    /^test isolation: the gate reached the synthetic live home:\n> \S+\/home\/\.local\/state\/atc\/stray\n$/u,
  );
});

test('it fails a gate that spawns claude from PATH and names the rule', async () => {
  const result = await run([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'claude --print "summarize the fixture"',
  ]);

  expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
    {
      exitCode: 1,
      stdout: '',
      stderr:
        'canary claude: never spawn the real claude in a test\n' +
        'test isolation: a test spawned the real claude binary; never spawn the real claude in a test, drive a stand-in:\n' +
        'claude --print summarize the fixture\n',
    },
  );
});

test('it fails a gate that spawns claude and then exits 0', async () => {
  const result = await run([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'claude --print "list the stub tasks" 2> /dev/null; exit 0',
  ]);

  expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
    {
      exitCode: 1,
      stdout: '',
      stderr:
        'test isolation: a test spawned the real claude binary; never spawn the real claude in a test, drive a stand-in:\n' +
        'claude --print list the stub tasks\n',
    },
  );
});

test('it exits with the code of a gate that fails', async () => {
  const result = await run([
    process.execPath,
    join(import.meta.dir, 'check-test-isolation.ts'),
    'sh',
    '-c',
    'exit 3',
  ]);

  expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
    {
      exitCode: 3,
      stdout: '',
      stderr: '',
    },
  );
});
