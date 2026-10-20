import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubTUIGrok } from './build-stub-tui-grok';
import { createStubBin } from './create-stub-bin';
import { readSourceEntry } from './read-source-entry';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startOutputCapture } from './start-output-capture';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { updateEnv } from './update-env';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-tui-grok-');

  // The reporter the script reports through sends its lines here.
  const reporter = startStubReporterSocket(join(temporaryDirectory.path, 'report.sock'));

  const bin = createStubBin(
    temporaryDirectory.path,
    'grok',
    buildStubTUIGrok(readSourceEntry('atc')),
  );

  return { directory: temporaryDirectory.path, bin, lines: reporter.lines };
}

test('it prints its marker with its arguments and then its hooks-done marker', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin, '--no-leader'], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.directory,
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const output = startOutputCapture(subprocess.stdout);

  await waitFor(() => {
    expect(output.read()).toBe('FAKE_GROK_UP args: --no-leader\nFAKE_GROK_HOOKS_DONE\n');
  });
});

test('it reports its session start and then a permission prompt through the reporter', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.directory,
    stdin: 'pipe',
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  expect(ctx.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      atcId: 's-1',
      event: 'SessionStart',
      payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: ctx.directory },
    },
    {
      atcId: 's-1',
      event: 'Notification',
      payload: {
        hookEventName: 'notification',
        sessionId: 'fake-grok-1',
        notificationType: 'permission_prompt',
        message: 'allow edit?',
      },
    },
  ]);
});

test('it reports the events file in place of the permission prompt', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'fake-grok-events.jsonl'),
    `${JSON.stringify({ hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' })}\n`,
  );

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.directory,
    stdin: 'pipe',
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const second = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);

    return ctx.lines[1] ?? '';
  });

  expect(JSON.parse(second)).toStrictEqual({
    atcId: 's-1',
    event: 'Stop',
    payload: { hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' },
  });
});

test('it reports nothing when the hold-start file exists', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'fake-grok-hold-start'), '');

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.directory,
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const output = startOutputCapture(subprocess.stdout);

  // The script reports before it starts echoing its input, so an echo comes
  // only after any report it would have sent.
  void subprocess.stdin.write('ping\n');
  void subprocess.stdin.flush();

  await waitFor(() => {
    expect(output.read()).toInclude('GOT:ping');
  });

  expect(ctx.lines).toBeEmpty();
});

test('it defers its session start until the defer file goes', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'fake-grok-defer-start'), '');

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.directory,
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const output = startOutputCapture(subprocess.stdout);

  await waitFor(() => {
    expect(join(ctx.directory, 'fake-grok-start-deferred')).toSatisfy(existsSync);
  });

  const reportedWhileDeferred = [...ctx.lines];

  rmSync(join(ctx.directory, 'fake-grok-defer-start'));

  await waitFor(() => {
    expect(output.read()).toInclude('FAKE_GROK_HOOKS_DONE');
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  expect(reportedWhileDeferred).toBeEmpty();

  expect(ctx.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      atcId: 's-1',
      event: 'SessionStart',
      payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: ctx.directory },
    },
    {
      atcId: 's-1',
      event: 'Notification',
      payload: {
        hookEventName: 'notification',
        sessionId: 'fake-grok-1',
        notificationType: 'permission_prompt',
        message: 'allow edit?',
      },
    },
  ]);
});

test('it reports through the CLI entry it is given, with none in the environment', async () => {
  const ctx = setupTest();
  const entry = readSourceEntry('atc');

  updateEnv('ATC_CLI_ENTRY', undefined);

  const bin = createStubBin(ctx.directory, 'given-entry', buildStubTUIGrok(entry));

  const subprocess = Bun.spawn([bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-given',
    },
    stdin: 'pipe',
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  await waitFor(() => {
    expect(ctx.lines.map((line): unknown => JSON.parse(line))).toPartiallyContain({
      atcId: 's-given',
      event: 'SessionStart',
    });
  });
});
