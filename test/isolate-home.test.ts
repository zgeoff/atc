import { expect, test } from 'bun:test';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
import { updateEnv } from './update-env';

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

test("it resolves the Claude config folder inside this run's own home", () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  expect(resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude')).toBe(join(root, 'home', '.claude'));
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

  const output = `${nested.stdout.toString()}${nested.stderr.toString()}`;

  expect(nested.exitCode).toBe(2);
  expect(output).toInclude('does not match the test home it marks');
  expect(output).not.toInclude('(pass)');
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

test("it resolves the XDG config, data, state, and cache homes inside this run's own home", () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  expect([
    process.env['XDG_CONFIG_HOME'],
    process.env['XDG_DATA_HOME'],
    process.env['XDG_STATE_HOME'],
    process.env['XDG_CACHE_HOME'],
  ]).toStrictEqual([
    join(root, 'home', '.config'),
    join(root, 'home', '.local', 'share'),
    join(root, 'home', '.local', 'state'),
    join(root, 'home', '.cache'),
  ]);
});

test('it runs git without the git config of the host XDG config home', () => {
  const read = Bun.spawnSync(['git', 'config', '--get', 'atc.canary'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(read.stdout.toString()).toBe('');
});

test('it keeps a host XDG git config away from a command the package script runs', () => {
  const root = process.env['ATC_TEST_HOME'];

  if (root === undefined) {
    throw new Error('the test home fixture is not in place');
  }

  const host = join(root, 'host-xdg-wrapped');

  mkdirSync(join(host, 'git'), { recursive: true });
  writeFileSync(join(host, 'git', 'config'), '[atc]\n\tcanary = host\n');

  const read = Bun.spawnSync(
    ['bash', 'scripts/with-test-home.sh', 'git', 'config', '--get', 'atc.canary'],
    {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, XDG_CONFIG_HOME: host },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect(read.stdout.toString()).toBe('');
});

test('it stops a bare bun test before any test runs', () => {
  const { ATC_TEST_HOME: _marker, ...outer } = process.env;

  const nested = Bun.spawnSync(
    ['bun', 'test', 'test/isolate-home.test.ts', '-t', 'no enclosing atc session'],
    {
      cwd: join(import.meta.dir, '..'),
      env: outer,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const output = `${nested.stdout.toString()}${nested.stderr.toString()}`;

  expect(nested.exitCode).toBe(2);
  expect(output).toInclude('run `bun run test` instead');
  expect(output).not.toInclude('(pass)');
});

// The preload restores overrides once for the whole process, so its effect
// shows across two tests: the second holds whether or not the first ran.
test('it overrides an environment variable for the running test', () => {
  updateEnv('ATC_TEST_PRELOAD_RESTORE_PROBE', 'overridden');

  expect(process.env['ATC_TEST_PRELOAD_RESTORE_PROBE']).toBe('overridden');
});

test("it starts each test without an earlier test's environment override", () => {
  expect(process.env).not.toContainKey('ATC_TEST_PRELOAD_RESTORE_PROBE');
});
