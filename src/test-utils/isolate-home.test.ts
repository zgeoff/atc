import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { resolveAgentHome } from '../agents/resolve-agent-home';
import {
  configFile,
  daemonPidFile,
  daemonSocketPath,
  dbFile,
  eventsSocketPath,
  legacyFleetFile,
  mcpAuthDBFile,
  socketPath,
  stateDir,
  statusFile,
} from '../shared/config';
import { setupTempDir } from './setup-temp-dir';

// Each subprocess test writes a fixture test file into its own temp
// directory and runs `bun test` on it from the repository root, where the
// bunfig preload applies, so a write or an override lands in the
// subprocess's own test home and never in this run's.
function setupTest() {
  const tmp = setupTempDir('atc-isolate-home-');

  return {
    dir: tmp.dir,
    repo: join(import.meta.dir, '..', '..'),
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

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

test("it writes a gateway's generated settings file inside the subprocess run's own home", () => {
  using ctx = setupTest();

  const fixture = join(ctx.dir, 'gateway-settings.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { GatewayAdapter } from '${join(ctx.repo, 'src', 'agents', 'gateway-adapter')}';
import { parseConfig, stateDir } from '${join(ctx.repo, 'src', 'shared', 'config')}';

test('it writes the settings file under the home', () => {
  const adapter = new GatewayAdapter(
    { id: 'isolation-probe', label: 'Isolation probe', mark: 'i', bin: 'claude', args: [], baseURL: 'https://gateway.example/anthropic', env: {} },
    parseConfig({}),
  );

  adapter.buildResumeCommand('/tmp', undefined);

  expect(realpathSync(join(stateDir, 'hook-settings-isolation-probe.json'))).toStartWith(
    realpathSync(join(process.env['ATC_TEST_HOME'] ?? '', 'home')) + sep,
  );
});

test('it holds a second test so the run reports both', () => {
  expect(stateDir).toBeString();
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({
    exitCode: nested.exitCode,
    output: `${nested.stdout.toString()}${nested.stderr.toString()}`,
  }).toStrictEqual({
    exitCode: 0,
    output: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it writes the atc-bridge mod inside the subprocess run's own home by default", () => {
  using ctx = setupTest();

  const fixture = join(ctx.dir, 'atc-bridge.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { writeATCBridge } from '${join(ctx.repo, 'src', 'agents', 'write-atc-bridge')}';

test('it writes the mod under the home', () => {
  const dir = writeATCBridge();

  expect(realpathSync(dir)).toStartWith(
    realpathSync(join(process.env['ATC_TEST_HOME'] ?? '', 'home')) + sep,
  );
});

test('it holds a second test so the run reports both', () => {
  expect(process.env['ATC_TEST_HOME']).toBeString();
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({
    exitCode: nested.exitCode,
    output: `${nested.stdout.toString()}${nested.stderr.toString()}`,
  }).toStrictEqual({
    exitCode: 0,
    output: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it puts back an environment override before the subprocess run's next test", () => {
  using ctx = setupTest();

  const fixture = join(ctx.dir, 'restore.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { updateEnv } from '${join(ctx.repo, 'src', 'test-utils', 'update-env')}';

test('it overrides a variable', () => {
  updateEnv('ATC_TEST_PRELOAD_RESTORE_PROBE', 'overridden');

  expect(process.env['ATC_TEST_PRELOAD_RESTORE_PROBE']).toBe('overridden');
});

test('it starts without the override', () => {
  expect(process.env).not.toContainKey('ATC_TEST_PRELOAD_RESTORE_PROBE');
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({
    exitCode: nested.exitCode,
    output: `${nested.stdout.toString()}${nested.stderr.toString()}`,
  }).toStrictEqual({
    exitCode: 0,
    output: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test('it stops a bare bun test before any test runs', () => {
  using ctx = setupTest();

  const fixture = join(ctx.dir, 'bare.test.ts');

  writeFileSync(
    fixture,
    `import { test } from 'bun:test';

test('it reports the first test ran', () => {
  console.log('fixture test ran');
});

test('it reports the second test ran', () => {
  console.log('fixture test ran');
});
`,
  );

  const { ATC_TEST_HOME: _marker, ...outer } = process.env;

  const nested = Bun.spawnSync(['bun', 'test', fixture], {
    cwd: ctx.repo,
    env: outer,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = `${nested.stdout.toString()}${nested.stderr.toString()}`;

  expect({
    exitCode: nested.exitCode,
    stopped: output.includes('run `bun run test` instead'),
    ran: output.includes('fixture test ran'),
  }).toStrictEqual({ exitCode: 2, stopped: true, ran: false });
});

test('it refuses to run under a test-home marker whose paths do not match it', () => {
  using ctx = setupTest();

  const fixture = join(ctx.dir, 'stale.test.ts');

  writeFileSync(
    fixture,
    `import { test } from 'bun:test';

test('it reports the first test ran', () => {
  console.log('fixture test ran');
});

test('it reports the second test ran', () => {
  console.log('fixture test ran');
});
`,
  );

  const nested = Bun.spawnSync(['bun', 'test', fixture], {
    cwd: ctx.repo,
    env: { ...process.env, ATC_TEST_HOME: join(ctx.dir, 'stale-marker') },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = `${nested.stdout.toString()}${nested.stderr.toString()}`;

  expect({
    exitCode: nested.exitCode,
    stopped: output.includes('does not match the test home it marks'),
    ran: output.includes('fixture test ran'),
  }).toStrictEqual({ exitCode: 2, stopped: true, ran: false });
});

test('it refuses to run under a test-home marker beside an enclosing atc session', () => {
  using ctx = setupTest();

  const fixture = join(ctx.dir, 'session.test.ts');

  writeFileSync(
    fixture,
    `import { test } from 'bun:test';

test('it reports the first test ran', () => {
  console.log('fixture test ran');
});

test('it reports the second test ran', () => {
  console.log('fixture test ran');
});
`,
  );

  const nested = Bun.spawnSync(['bun', 'test', fixture], {
    cwd: ctx.repo,
    env: { ...process.env, ATC_SESSION_ID: 's1-enclosing' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = `${nested.stdout.toString()}${nested.stderr.toString()}`;

  expect({
    exitCode: nested.exitCode,
    stopped: output.includes('but ATC_SESSION_ID does not match the test home it marks'),
    ran: output.includes('fixture test ran'),
  }).toStrictEqual({ exitCode: 2, stopped: true, ran: false });
});

test('it accepts the test home the package script sets up under a temp directory ending in a slash', () => {
  using ctx = setupTest();

  const fixture = join(ctx.dir, 'slash.test.ts');

  writeFileSync(
    fixture,
    `import { test } from 'bun:test';

test('it reports the first test ran', () => {
  console.log('fixture test ran');
});

test('it reports the second test ran', () => {
  console.log('fixture test ran');
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: { ...process.env, TMPDIR: `${ctx.dir}/` },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({
    exitCode: nested.exitCode,
    output: `${nested.stdout.toString()}${nested.stderr.toString()}`,
  }).toStrictEqual({
    exitCode: 0,
    output: expect.toSatisfy((output: string) =>
      /fixture test ran[\s\S]*fixture test ran[\s\S]* 2 pass\n/.test(output),
    ),
  });
});

test('it keeps a host XDG git config away from a command the package script runs', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, 'host-xdg');

  mkdirSync(join(host, 'git'), { recursive: true });
  writeFileSync(join(host, 'git', 'config'), '[atc]\n\tcanary = host\n');

  const read = Bun.spawnSync(
    ['bash', 'scripts/with-test-home.sh', 'git', 'config', '--get', 'atc.canary'],
    {
      cwd: ctx.repo,
      env: { ...process.env, XDG_CONFIG_HOME: host },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect(read.stdout.toString()).toBe('');
});
