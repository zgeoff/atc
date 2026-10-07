import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubTUIGrok } from './build-stub-tui-grok';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { startOutputCapture } from './start-output-capture';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { waitFor } from './wait-for';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-tui-grok-'));

  // The reporter the script reports through sends its lines here.
  const reporter = stack.use(startStubReporterSocket(join(tmp.dir, 'report.sock')));
  const bin = createStubBin(tmp.dir, 'grok', buildStubTUIGrok());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    bin,
    lines: reporter.lines,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it prints its marker with its arguments and then its hooks-done marker', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin, '--no-leader'], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.dir,
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const output = startOutputCapture(proc.stdout);

  await waitFor(() => {
    expect(output.read()).toBe('FAKE_GROK_UP args: --no-leader\nFAKE_GROK_HOOKS_DONE\n');
  });
});

test('it reports its session start and then a permission prompt through the reporter', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.dir,
    stdin: 'pipe',
    stdout: 'ignore',
  });

  onTestFinished(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  expect(ctx.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      atcId: 's-1',
      event: 'SessionStart',
      payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: ctx.dir },
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
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'fake-grok-events.jsonl'),
    `${JSON.stringify({ hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' })}\n`,
  );

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.dir,
    stdin: 'pipe',
    stdout: 'ignore',
  });

  onTestFinished(() => {
    proc.kill();
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
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-grok-hold-start'), '');

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.dir,
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const output = startOutputCapture(proc.stdout);

  // The script reports before it starts echoing its input, so an echo comes
  // only after any report it would have sent.
  void proc.stdin.write('ping\n');
  void proc.stdin.flush();

  await waitFor(() => {
    expect(output.read()).toInclude('GOT:ping');
  });

  expect(ctx.lines).toBeEmpty();
});

test('it defers its session start until the defer file goes', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-grok-defer-start'), '');

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    cwd: ctx.dir,
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const output = startOutputCapture(proc.stdout);

  await waitFor(() => {
    expect(join(ctx.dir, 'fake-grok-start-deferred')).toSatisfy(existsSync);
  });

  const reportedWhileDeferred = [...ctx.lines];

  rmSync(join(ctx.dir, 'fake-grok-defer-start'));

  await waitFor(() => {
    expect(output.read()).toInclude('FAKE_GROK_HOOKS_DONE');
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  expect(reportedWhileDeferred).toBeEmpty();
});
