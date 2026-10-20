import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubMCPGrok } from './build-stub-mcp-grok';
import { createStubBin } from './create-stub-bin';
import { readSourceEntry } from './read-source-entry';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { updateEnv } from './update-env';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-mcp-grok-');

  // The reporter the script reports through sends its lines here.
  const reporter = startStubReporterSocket(join(temporaryDirectory.path, 'report.sock'));

  const bin = createStubBin(
    temporaryDirectory.path,
    'grok',
    buildStubMCPGrok(readSourceEntry('atc')),
  );

  return {
    directory: temporaryDirectory.path,
    bin,
    lines: reporter.lines,
  };
}

test('it prints its marker and arguments', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin, '--model', 'grok-5'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  void subprocess.stdin.end();

  const output = await new Response(subprocess.stdout).text();

  expect(output).toBe('FAKE_GROK_UP args: --model grok-5\n');
});

test('it records its pid in the home', async () => {
  const ctx = setupTest();

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
    output: 'FAKE_GROK_UP args: \nping\n',
    exitCode: 0,
  });
});

test('it reports session_start with its session id and working directory through the reporter', async () => {
  const ctx = setupTest();

  const subprocess = Bun.spawn([ctx.bin], {
    cwd: ctx.directory,
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
    payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: ctx.directory },
  });
});

test('it reports through the CLI entry it is given, with none in the environment', async () => {
  const ctx = setupTest();
  const entry = readSourceEntry('atc');

  updateEnv('ATC_CLI_ENTRY', undefined);

  const bin = createStubBin(ctx.directory, 'given-entry', buildStubMCPGrok(entry));

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
