import { expect, onTestFinished, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { isProcessAlive } from '../shared/is-process-alive';
import { registerTestCleanup } from './register-test-cleanup';
import { setupMCPHome } from './setup-mcp-home';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

test('it writes a config that registers the stand-in agents', async () => {
  const mcpHome = setupMCPHome();

  const config: unknown = await Bun.file(
    join(mcpHome.home, '.config', 'atc', 'config.json'),
  ).json();

  expect(config).toStrictEqual({
    claudeBin: join(mcpHome.home, 'fake-claude'),
    claudeArgs: [],
    grokBin: join(mcpHome.home, 'fake-grok'),
    grokArgs: [],
  });
});

test('it writes the stand-in claude as an executable', async () => {
  const mcpHome = setupMCPHome();

  writeFileSync(join(mcpHome.home, 'fake-claude-hold-start'), '');

  const claude = Bun.spawn([mcpHome.claudeBin], {
    env: { HOME: mcpHome.home },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    claude.kill();
  });

  void claude.stdin.end();

  const output = await new Response(claude.stdout).text();

  expect(output).toBe('FAKE_CLAUDE_UP args: \n');
});

test('it stops the daemon its pid file holds before removing the home', async () => {
  const mcpHome = setupMCPHome();
  const records = setupTempDir('atc-mcp-home-records-');
  const seen = join(records.dir, 'seen');

  // A daemon that writes the status of a test for its home when the stop
  // signals it, 0 while the home exists, and prints a line once it can.
  const daemon = Bun.spawn(
    [
      'bash',
      '-c',
      'trap \'test -d "$1"; echo $? > "$2"; kill $!; exit 0\' TERM; echo ready; sleep 30 & wait',
      'daemon',
      mcpHome.home,
      seen,
    ],
    { stdout: 'pipe' },
  );

  onTestFinished(() => {
    daemon.kill('SIGKILL');
  });

  await daemon.stdout.getReader().read();

  writeFileSync(join(mcpHome.home, 'atc-daemon.pid'), String(daemon.pid));

  await mcpHome.teardown();

  expect(readFileSync(seen, 'utf8')).toBe('0\n');
  expect(isProcessAlive(daemon.pid)).toBe(false);
  expect(existsSync(mcpHome.home)).toBe(false);
});

test("it kills every process in a recorded stand-in's process group", async () => {
  const mcpHome = setupMCPHome();

  const stub = spawn('bash', ['-c', 'echo $$ >> "$HOME/stub-pids"; sleep 30 & exec sleep 30'], {
    detached: true,
    env: { HOME: mcpHome.home, PATH: '/usr/bin:/bin' },
    stdio: 'ignore',
  });

  onTestFinished(() => {
    stub.kill();
  });

  const group = stub.pid;

  invariant(group !== undefined, 'the stand-in did not start');

  // The append creates the file before it writes the pid, so the wait is on
  // the pid itself.
  await waitFor(() => {
    expect(readFileSync(join(mcpHome.home, 'stub-pids'), 'utf8')).toBe(`${group}\n`);
  });

  await mcpHome.teardown();

  expect(() => process.kill(-group, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('it never kills a process outside the recorded process groups', async () => {
  const mcpHome = setupMCPHome();
  const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });

  onTestFinished(() => {
    bystander.kill();
  });

  invariant(bystander.pid !== undefined, 'the bystander did not start');

  await mcpHome.teardown();

  expect(isProcessAlive(bystander.pid)).toBeTrue();
});

test('it removes a home that holds no daemon pid', async () => {
  const mcpHome = setupMCPHome();

  await mcpHome.teardown();

  expect(existsSync(mcpHome.home)).toBeFalse();
});

test("it kills a recorded stand-in's process group and removes the home once the test finishes", async () => {
  const mcpHome = setupMCPHome();

  // The group's leader records itself and leaves a child in its group, so
  // only a kill of the whole group ends that child.
  const stub = spawn('bash', ['-c', 'echo $$ >> "$HOME/stub-pids"; sleep 30 & exec sleep 30'], {
    detached: true,
    env: { HOME: mcpHome.home, PATH: '/usr/bin:/bin' },
    stdio: 'ignore',
  });

  onTestFinished(() => {
    stub.kill();
  });

  const group = stub.pid;

  invariant(group !== undefined, 'the stand-in did not start');

  // The append creates the file before it writes the pid, so the wait is on
  // the pid itself.
  await waitFor(() => {
    expect(readFileSync(join(mcpHome.home, 'stub-pids'), 'utf8')).toBe(`${group}\n`);
  });

  onTestFinished(() => {
    expect(() => process.kill(-group, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(existsSync(mcpHome.home)).toBeFalse();
  });
});
