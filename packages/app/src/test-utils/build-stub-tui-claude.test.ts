import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { readSourceEntry } from '@atc/core/test-utils/read-source-entry';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { startOutputCapture } from '@atc/core/test-utils/start-output-capture';
import { updateEnv } from '@atc/core/test-utils/update-env';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { startStubReporterSocket } from '@atc/protocol/test-utils/start-stub-reporter-socket';
import { buildStubTUIClaude } from './build-stub-tui-claude';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-tui-claude-');
  const reporter = startStubReporterSocket(join(temporaryDirectory.path, 'report.sock'));

  const bin = createStubBin(
    temporaryDirectory.path,
    'claude',
    buildStubTUIClaude(readSourceEntry('atc')),
  );

  return { directory: temporaryDirectory.path, bin, lines: reporter.lines };
}

test('it keeps the read loop free of command substitution, so a SIGWINCH cannot break the paint trap', () => {
  const loop = /^\s*for [^\n]*; do\n(?:[^\n]*\n)*?\s*done$/mu.exec(
    buildStubTUIClaude(readSourceEntry('atc')),
  )?.[0];

  expect(loop).toInclude('read -t');
  expect(loop).not.toMatch(/\$\(|`/u);
});

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

test('it runs the message tap for its session when the tap file exists', async () => {
  const ctx = setupTest();
  const calls = join(ctx.directory, 'calls.txt');
  const entry = join(ctx.directory, 'record-args.ts');

  writeFileSync(
    entry,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\n`,
  );

  writeFileSync(join(ctx.directory, 'fake-claude-tap'), '');

  const bin = createStubBin(ctx.directory, 'tapped', buildStubTUIClaude(entry));

  const subprocess = Bun.spawn([bin], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin', ATC_SESSION_ID: 's-tap' },
    stdin: 'pipe',
    detached: true,
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  await waitFor(async () => {
    const called = await Bun.file(calls).text();

    expect(called).toInclude('tap --session s-tap\n');
  });
});

test('it runs no message tap without the tap file', async () => {
  const ctx = setupTest();
  const calls = join(ctx.directory, 'calls.txt');
  const entry = join(ctx.directory, 'record-args.ts');

  writeFileSync(
    entry,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\n`,
  );

  const bin = createStubBin(ctx.directory, 'untapped', buildStubTUIClaude(entry));

  const subprocess = Bun.spawn([bin], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin', ATC_SESSION_ID: 's-tap' },
    stdin: 'pipe',
    detached: true,
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  // The notification is the stand-in's last report, so every earlier call has run once it lands.
  await waitFor(async () => {
    const called = await Bun.file(calls).text();

    expect(called).toBe('hook-report\nhook-report\n');
  });
});
