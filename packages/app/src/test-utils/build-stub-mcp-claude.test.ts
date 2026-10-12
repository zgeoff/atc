import { expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-mcp-claude-');

  // The reporter the script reports through sends its lines here.
  const reporter = startStubReporterSocket(join(tmp.dir, 'report.sock'));
  const bin = createStubBin(tmp.dir, 'claude', buildStubMCPClaude());

  return {
    dir: tmp.dir,
    bin,
    lines: reporter.lines,
  };
}

test('it prints its marker and arguments', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const proc = Bun.spawn([ctx.bin, '--model', 'opus'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  void proc.stdin.end();

  const output = await new Response(proc.stdout).text();

  expect(output).toBe('FAKE_CLAUDE_UP args: --model opus\n');
});

test('it records its pid in the home', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const proc = Bun.spawn([ctx.bin], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  void proc.stdin.end();

  await proc.exited;

  expect(readFileSync(join(ctx.dir, 'stub-pids'), 'utf8')).toBe(`${proc.pid}\n`);
});

test('it reports nothing when the home holds the hold-start file', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const held = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
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
  rmSync(join(ctx.dir, 'fake-claude-hold-start'));

  const sentinel = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
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
        transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
      },
    },
  ]);
});

test('it stays up after reporting, echoing its input back until the input closes', async () => {
  const ctx = setupTest();

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

  registerTestCleanup(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(1);
  });

  void proc.stdin.write('ping\n');
  void proc.stdin.end();

  const output = await new Response(proc.stdout).text();

  expect({ output, exitCode: await proc.exited }).toStrictEqual({
    output: 'FAKE_CLAUDE_UP args: \nping\n',
    exitCode: 0,
  });
});

test('it reports SessionStart with its session id and transcript through the reporter', async () => {
  const ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(1);

    return ctx.lines[0];
  });

  await proc.exited;

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'SessionStart',
    payload: {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
    },
  });
});

test('it files the note file as a decision note', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-note'), 'pick the second option');

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);

    return ctx.lines[1];
  });

  await proc.exited;

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'Note',
    payload: { kind: 'note', label: 'decision', text: 'pick the second option' },
  });
});
