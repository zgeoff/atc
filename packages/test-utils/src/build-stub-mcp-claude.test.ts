import { expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { createStubBin } from './create-stub-bin';
import { readSourceEntry } from './read-source-entry';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { updateEnv } from './update-env';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-mcp-claude-');

  // The reporter the script reports through sends its lines here.
  const reporter = startStubReporterSocket(join(temporaryDirectory.path, 'report.sock'));

  const bin = createStubBin(
    temporaryDirectory.path,
    'claude',
    buildStubMCPClaude(readSourceEntry('atc')),
  );

  return {
    directory: temporaryDirectory.path,
    bin,
    lines: reporter.lines,
  };
}

test('it prints its marker and arguments', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'fake-claude-hold-start'), '');

  const subprocess = Bun.spawn([ctx.bin, '--model', 'opus'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  void subprocess.stdin.end();

  const output = await new Response(subprocess.stdout).text();

  expect(output).toBe('FAKE_CLAUDE_UP args: --model opus\n');
});

test('it records its pid in the home', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'fake-claude-hold-start'), '');

  const subprocess = Bun.spawn([ctx.bin], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  void subprocess.stdin.end();

  await subprocess.exited;

  expect(readFileSync(join(ctx.directory, 'stub-pids'), 'utf8')).toBe(`${subprocess.pid}\n`);
});

test('it reports nothing when the home holds the hold-start file', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'fake-claude-hold-start'), '');

  const held = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-held',
    },
    stdin: 'pipe',
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    held.kill();
  });

  void held.stdin.end();

  await held.exited;

  // A run without the hold-start file reports after the held run has ended,
  // so its line arrives after any line the held run sent.
  rmSync(join(ctx.directory, 'fake-claude-hold-start'));

  const sentinel = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-sentinel',
    },
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    sentinel.kill();
  });

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(1);
  });

  expect(ctx.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      atcId: 's-sentinel',
      event: 'SessionStart',
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'fake-1',
        transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
      },
    },
  ]);
});

test('it stays up after reporting, echoing its input back until the input closes', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(1);
  });

  void subprocess.stdin.write('ping\n');
  void subprocess.stdin.end();

  const output = await new Response(subprocess.stdout).text();

  expect({ output, exitCode: await subprocess.exited }).toStrictEqual({
    output: 'FAKE_CLAUDE_UP args: \nping\n',
    exitCode: 0,
  });
});

test('it reports SessionStart with its session id and transcript through the reporter', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(1);

    return ctx.lines[0];
  });

  await subprocess.exited;

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'SessionStart',
    payload: {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
    },
  });
});

test('it files the note file as a decision note', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'fake-claude-note'), 'pick the second option');

  const subprocess = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.directory,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.directory, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);

    return ctx.lines[1];
  });

  await subprocess.exited;

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'Note',
    payload: { kind: 'note', label: 'decision', text: 'pick the second option' },
  });
});

test('it reports through the CLI entry it is given, with none in the environment', async () => {
  const ctx = setupTest();
  const entry = readSourceEntry('atc');

  updateEnv('ATC_CLI_ENTRY', undefined);

  const bin = createStubBin(ctx.directory, 'given-entry', buildStubMCPClaude(entry));

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
