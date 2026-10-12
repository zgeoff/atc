import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubMCPGrok } from './build-stub-mcp-grok';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-mcp-grok-');

  // The reporter the script reports through sends its lines here.
  const reporter = startStubReporterSocket(join(tmp.dir, 'report.sock'));
  const bin = createStubBin(tmp.dir, 'grok', buildStubMCPGrok());

  return {
    dir: tmp.dir,
    bin,
    lines: reporter.lines,
  };
}

test('it prints its marker and arguments', async () => {
  const ctx = setupTest();

  const proc = Bun.spawn([ctx.bin, '--model', 'grok-5'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  void proc.stdin.end();

  const output = await new Response(proc.stdout).text();

  expect(output).toBe('FAKE_GROK_UP args: --model grok-5\n');
});

test('it records its pid in the home', async () => {
  const ctx = setupTest();

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
    output: 'FAKE_GROK_UP args: \nping\n',
    exitCode: 0,
  });
});

test('it reports session_start with its session id and working directory through the reporter', async () => {
  const ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    cwd: ctx.dir,
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
    payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: ctx.dir },
  });
});
