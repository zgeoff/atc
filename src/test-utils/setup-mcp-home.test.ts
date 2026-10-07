import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '../shared/is-process-alive';
import { setupMCPHome } from './setup-mcp-home';

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

  const claude = Bun.spawn([mcpHome.claudeBin], { env: { HOME: mcpHome.home }, stdout: 'pipe' });

  onTestFinished(() => {
    claude.kill();
  });

  const first = await claude.stdout.getReader().read();

  expect(new TextDecoder().decode(first.value)).toBe('FAKE_CLAUDE_UP args: \n');
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

test('it kills a process still running with its home before removing it', async () => {
  const mcpHome = setupMCPHome();
  const straggler = Bun.spawn(['sleep', '30'], { env: { HOME: mcpHome.home } });

  onTestFinished(() => {
    straggler.kill();
  });

  await mcpHome[Symbol.asyncDispose]();

  await straggler.exited;

  expect(straggler.signalCode).toBe('SIGKILL');
});

test('it never kills a process running with another home', async () => {
  const mcpHome = setupMCPHome();
  const bystander = Bun.spawn(['sleep', '30'], { env: { HOME: `${mcpHome.home}-other` } });

  onTestFinished(() => {
    bystander.kill();
  });

  await mcpHome[Symbol.asyncDispose]();

  expect(isProcessAlive(bystander.pid)).toBeTrue();
});

test('it removes a home that holds no daemon pid', async () => {
  const mcpHome = setupMCPHome();

  await mcpHome[Symbol.asyncDispose]();

  expect(existsSync(mcpHome.home)).toBeFalse();
});
