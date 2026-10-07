import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubTUIClaude } from './build-stub-tui-claude';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { startOutputCapture } from './start-output-capture';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { waitFor } from './wait-for';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-tui-claude-'));

  // The reporter the script reports through sends its lines here.
  const reporter = stack.use(startStubReporterSocket(join(tmp.dir, 'report.sock')));
  const bin = createStubBin(tmp.dir, 'claude', buildStubTUIClaude());
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

test('it prints its marker with its arguments', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin, '--model', 'opus'], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const output = startOutputCapture(proc.stdout);

  const printed = await waitFor(() => {
    expect(output.read()).toInclude('\n');

    return output.read();
  });

  expect(printed).toBe('FAKE_CLAUDE_UP args: --model opus\n');
});

test('it reports SessionStart and then a permission notification through the reporter', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
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
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'fake-1',
        transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
      },
    },
    {
      atcId: 's-1',
      event: 'Notification',
      payload: {
        hook_event_name: 'Notification',
        session_id: 'fake-1',
        message: 'needs permission',
      },
    },
  ]);
});

test('it reports the events file in place of the notification', async () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'fake-claude-events.jsonl'),
    `${JSON.stringify({ hook_event_name: 'Stop', session_id: 'fake-1' })}\n`,
  );

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
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
    payload: { hook_event_name: 'Stop', session_id: 'fake-1' },
  });
});

test('it prints its marker again on SIGWINCH', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin, '--x'], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const output = startOutputCapture(proc.stdout);

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  proc.kill('SIGWINCH');

  await waitFor(() => {
    expect(output.read()).toBe('FAKE_CLAUDE_UP args: --x\nFAKE_CLAUDE_UP args: --x\n');
  });
});

test('it echoes each line it reads', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const output = startOutputCapture(proc.stdout);

  void proc.stdin.write('ping\n');
  void proc.stdin.flush();

  const printed = await waitFor(() => {
    expect(output.read()).toInclude('GOT:ping\n');

    return output.read();
  });

  expect(printed).toBe('FAKE_CLAUDE_UP args: \nGOT:ping\n');
});

test('it holds a resumed run until the hold file goes, printing nothing before', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-resume'), '');

  const proc = Bun.spawn([ctx.bin, '--resume', 'fake-1'], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const output = startOutputCapture(proc.stdout);

  await waitFor(() => {
    expect(join(ctx.dir, 'fake-claude-resume-held')).toSatisfy(existsSync);
  });

  const printedWhileHeld = output.read();

  rmSync(join(ctx.dir, 'fake-claude-hold-resume'));

  const printedAfter = await waitFor(() => {
    expect(output.read()).toInclude('\n');

    return output.read();
  });

  expect({ printedWhileHeld, printedAfter }).toStrictEqual({
    printedWhileHeld: '',
    printedAfter: 'FAKE_CLAUDE_UP args: --resume fake-1\n',
  });
});
