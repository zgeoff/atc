import { expect, onTestFinished, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const mcpHome = setupMCPHome();
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
  const mcpHome = setupMCPHome();

  const stub = spawn('bash', ['-c', 'echo $$ >> "$HOME/stub-pids"; sleep 30 & exec sleep 30'], {
    detached: true,
    env: { HOME: mcpHome.home, PATH: '/usr/bin:/bin' },
    stdio: 'ignore',
  });

  const group = stub.pid;

  onTestFinished(() => {
    stub.kill();
  });

  if (group === undefined) {
    throw new Error('the stand-in did not start');
  }

  await waitFor(() => {
    expect(existsSync(join(mcpHome.home, 'stub-pids'))).toBeTrue();
  });

  await mcpHome[Symbol.asyncDispose]();

  expect(() => process.kill(-group, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('it never kills a process outside the recorded process groups', async () => {
  const mcpHome = setupMCPHome();
  const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });

  onTestFinished(() => {
    bystander.kill();
  });

  if (bystander.pid === undefined) {
    throw new Error('the bystander did not start');
  }

  await mcpHome[Symbol.asyncDispose]();

  expect(isProcessAlive(bystander.pid)).toBeTrue();
});

test('it removes a home that holds no daemon pid', async () => {
  const mcpHome = setupMCPHome();

  await mcpHome[Symbol.asyncDispose]();

  expect(existsSync(mcpHome.home)).toBeFalse();
});
