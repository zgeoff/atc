import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubTUIClaude } from './build-stub-tui-claude';
import { createStubBin } from './create-stub-bin';
import { readSourceEntry } from './read-source-entry';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startOutputCapture } from './start-output-capture';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { updateEnv } from './update-env';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-tui-claude-');

  // The reporter the script reports through sends its lines here.
  const reporter = startStubReporterSocket(join(temporaryDirectory.path, 'report.sock'));

  const bin = createStubBin(
    temporaryDirectory.path,
    'claude',
    buildStubTUIClaude(readSourceEntry('atc')),
  );

  return { directory: temporaryDirectory.path, bin, lines: reporter.lines };
}

test('it prints its marker with its arguments', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin, '--model', 'opus'], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',

    // A reporter the script started outlives the script and writes Bun's
    // cache back into the removed home, so each test kills the whole group.
    detached: true,
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  const output = startOutputCapture(subprocess.stdout);

  const printed = await waitFor(() => {
    expect(output.read()).toInclude('\n');

    return output.read();
  });

  expect(printed).toBe('FAKE_CLAUDE_UP args: --model opus\n');
});

test('it reports SessionStart and then a permission notification through the reporter', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    detached: true,
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
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
        transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
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
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'fake-claude-events.jsonl'),
    `${JSON.stringify({ hook_event_name: 'Stop', session_id: 'fake-1' })}\n`,
  );

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    detached: true,
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
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
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin, '--x'], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    detached: true,
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  const output = startOutputCapture(subprocess.stdout);

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  subprocess.kill('SIGWINCH');

  await waitFor(() => {
    expect(output.read()).toBe('FAKE_CLAUDE_UP args: --x\nFAKE_CLAUDE_UP args: --x\n');
  });
});

test('it echoes each line it reads', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    detached: true,
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  const output = startOutputCapture(subprocess.stdout);

  void subprocess.stdin.write('ping\n');
  void subprocess.stdin.flush();

  const printed = await waitFor(() => {
    expect(output.read()).toInclude('GOT:ping\n');

    return output.read();
  });

  expect(printed).toBe('FAKE_CLAUDE_UP args: \nGOT:ping\n');
});

test('it holds a resumed run until the hold file goes, printing nothing before', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'fake-claude-hold-resume'), '');

  const subprocess = Bun.spawn([ctx.bin, '--resume', 'fake-1'], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    detached: true,
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  const output = startOutputCapture(subprocess.stdout);

  await waitFor(() => {
    expect(join(ctx.directory, 'fake-claude-resume-held')).toSatisfy(existsSync);
  });

  const printedWhileHeld = output.read();

  rmSync(join(ctx.directory, 'fake-claude-hold-resume'));

  const printedAfter = await waitFor(() => {
    expect(output.read()).toInclude('\n');

    return output.read();
  });

  expect(printedWhileHeld).toBe('');
  expect(printedAfter).toBe('FAKE_CLAUDE_UP args: --resume fake-1\n');
});

test('it reports through the CLI entry it is given, with none in the environment', async () => {
  const ctx = setupTest();
  const entry = readSourceEntry('atc');

  updateEnv('ATC_CLI_ENTRY', undefined);

  const bin = createStubBin(ctx.directory, 'given-entry', buildStubTUIClaude(entry));

  const subprocess = Bun.spawn([bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-given',
    },
    stdin: 'pipe',
    detached: true,
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  await waitFor(() => {
    expect(ctx.lines.map((line): unknown => JSON.parse(line))).toPartiallyContain({
      atcId: 's-given',
      event: 'SessionStart',
    });
  });
});
