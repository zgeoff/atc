import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { waitFor } from './wait-for';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-mcp-claude-'));

  // The reporter the script reports through sends its lines here.
  const reporter = stack.use(startStubReporterSocket(join(tmp.dir, 'report.sock')));
  const bin = createStubBin(tmp.dir, 'claude', buildStubMCPClaude());
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

test('it prints its marker and arguments', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const proc = Bun.spawn([ctx.bin, '--model', 'opus'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  void proc.stdin.end();

  const output = await new Response(proc.stdout).text();

  expect(output).toBe('FAKE_CLAUDE_UP args: --model opus\n');
});

test('it records its pid in the home', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const proc = Bun.spawn([ctx.bin], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  void proc.stdin.end();

  await proc.exited;

  expect(readFileSync(join(ctx.dir, 'stub-pids'), 'utf8')).toBe(`${proc.pid}\n`);
});

test('it stays up after reporting, echoing its input back until the input closes', async () => {
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
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  onTestFinished(() => {
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

test('it files the note file as a decision report', async () => {
  using ctx = setupTest();

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

  onTestFinished(() => {
    proc.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);

    return ctx.lines[1];
  });

  await proc.exited;

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'Report',
    payload: { kind: 'note', label: 'decision', text: 'pick the second option' },
  });
});
