import { expect, test } from 'bun:test';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { GatewayAdapter } from '../src/agents/gateway-adapter';
import { resolveAgentHome } from '../src/agents/resolve-agent-home';
import { writeATCBridge } from '../src/agents/write-atc-bridge';
import {
  configFile,
  daemonPidFile,
  daemonSocketPath,
  dbFile,
  eventsSocketPath,
  legacyFleetFile,
  mcpAuthDBFile,
  parseConfig,
  socketPath,
  stateDir,
  statusFile,
} from '../src/shared/config';

test("it resolves every atc config and state path inside this run's own home", () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  expect([configFile, stateDir, statusFile, dbFile, mcpAuthDBFile, legacyFleetFile]).toSatisfyAll(
    (path: string) => path.startsWith(`${join(root, 'home')}${sep}`),
  );
});

test("it resolves every atc socket and the daemon record inside this run's own runtime directory", () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  expect([socketPath, daemonSocketPath, eventsSocketPath, daemonPidFile]).toSatisfyAll(
    (path: string) => path.startsWith(`${join(root, 'runtime')}${sep}`),
  );
});

test("it resolves the grok and codex homes inside this run's own home", () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  expect([
    resolveAgentHome('GROK_HOME', '.grok'),
    resolveAgentHome('CODEX_HOME', '.codex'),
  ]).toStrictEqual([join(root, 'home', '.grok'), join(root, 'home', '.codex')]);
});

test('it runs with no enclosing atc session to report to', () => {
  expect(process.env).not.toContainAnyKeys(['ATC_SESSION_ID', 'ATC_SOCKET']);
});

test("it writes a gateway's generated settings file inside this run's own home", () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined || !stateDir.startsWith(`${join(root, 'home')}${sep}`)) {
    throw new Error(`refusing to write: ${stateDir} is not inside the test home fixture`);
  }

  const adapter = new GatewayAdapter(
    {
      id: 'isolation-probe',
      label: 'Isolation probe',
      mark: 'i',
      bin: 'claude',
      args: [],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
    },
    parseConfig({}),
  );

  adapter.buildResumeCommand('/tmp', undefined);

  expect(realpathSync(join(stateDir, 'hook-settings-isolation-probe.json'))).toStartWith(
    `${realpathSync(join(root, 'home'))}${sep}`,
  );
});

test("it writes the atc-bridge mod inside this run's own home by default", () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined || !stateDir.startsWith(`${join(root, 'home')}${sep}`)) {
    throw new Error(`refusing to write: ${stateDir} is not inside the test home fixture`);
  }

  const dir = writeATCBridge();

  expect(realpathSync(dir)).toStartWith(`${realpathSync(join(root, 'home'))}${sep}`);
});

test('it refuses to run under a test-home marker whose paths do not match it', () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  const nested = Bun.spawnSync(
    ['bun', 'test', 'test/isolate-home.test.ts', '-t', 'no enclosing atc session'],
    {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, ATC_TEST_HOME: join(root, 'stale-marker') },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect(nested.exitCode).not.toBe(0);
  expect(nested.stderr.toString()).toInclude('does not match the test home it marks');
});

test('it accepts the test home the package script sets up under a temp directory ending in a slash', () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  const tmp = join(root, 'slash-tmp');

  mkdirSync(tmp);

  const nested = Bun.spawnSync(
    [
      'bash',
      'scripts/with-test-home.sh',
      'bun',
      'test',
      'test/isolate-home.test.ts',
      '-t',
      'no enclosing atc session',
    ],
    {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, TMPDIR: `${tmp}/` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect(nested.exitCode).toBe(0);
});
