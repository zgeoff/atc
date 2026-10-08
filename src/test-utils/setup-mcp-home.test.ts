import { expect, onTestFinished, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { isProcessAlive } from '../shared/is-process-alive';
import { setupMCPHome } from './setup-mcp-home';
import { waitFor } from './wait-for';

test('it writes a config that registers the stand-in agents', async () => {
  await using mcpHome = setupMCPHome();

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
  await using mcpHome = setupMCPHome();

  writeFileSync(join(mcpHome.home, 'fake-claude-hold-start'), '');

  const claude = Bun.spawn([mcpHome.claudeBin], {
    env: { HOME: mcpHome.home },
    stdin: 'pipe',
    stdout: 'pipe',
  });

  onTestFinished(() => {
    claude.kill();
  });

  void claude.stdin.end();

  const output = await new Response(claude.stdout).text();

  expect(output).toBe('FAKE_CLAUDE_UP args: \n');
});

test('it stops the daemon its pid file holds before removing the home', async () => {
  await using mcpHome = setupMCPHome();

  const daemon = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    daemon.kill();
  });

  writeFileSync(join(mcpHome.home, 'atc-daemon.pid'), String(daemon.pid));

  await mcpHome[Symbol.asyncDispose]();

  expect({ alive: isProcessAlive(daemon.pid), home: existsSync(mcpHome.home) }).toStrictEqual({
    alive: false,
    home: false,
  });
});

test("it kills every process in a recorded stand-in's process group", async () => {
  await using mcpHome = setupMCPHome();

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

  await waitFor(() => {
    expect(existsSync(join(mcpHome.home, 'stub-pids'))).toBeTrue();
  });

  await mcpHome[Symbol.asyncDispose]();

  expect(() => process.kill(-group, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('it never kills a process outside the recorded process groups', async () => {
  await using mcpHome = setupMCPHome();

  const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });

  onTestFinished(() => {
    bystander.kill();
  });

  invariant(bystander.pid !== undefined, 'the bystander did not start');

  await mcpHome[Symbol.asyncDispose]();

  expect(isProcessAlive(bystander.pid)).toBeTrue();
});

test('it removes a home that holds no daemon pid', async () => {
  await using mcpHome = setupMCPHome();

  await mcpHome[Symbol.asyncDispose]();

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

  await waitFor(() => {
    expect(existsSync(join(mcpHome.home, 'stub-pids'))).toBeTrue();
  });

  onTestFinished(() => {
    expect(() => process.kill(-group, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(existsSync(mcpHome.home)).toBeFalse();
  });
});

test('it removes the home once when disposed before the test finishes', async () => {
  const mcpHome = setupMCPHome();

  await mcpHome[Symbol.asyncDispose]();

  expect(existsSync(mcpHome.home)).toBeFalse();
});
