import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';

// Each test writes a two-test fixture file into its own temp directory and
// runs `bun test` on it in a subprocess from the repository root, where the
// bunfig preload applies, so every check runs in a test home of its own and
// a write or an override never lands in this run's.
function setupTest() {
  const tmp = setupTempDir('atc-isolate-home-');

  return {
    dir: tmp.dir,
    repo: join(import.meta.dir, '..', '..'),
  };
}

test("it resolves every atc config and state path inside the run's own home", () => {
  const ctx = setupTest();
  const fixture = join(ctx.dir, 'state-paths.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { join, sep } from 'node:path';
import { configFile, dbFile, legacyFleetFile, mcpAuthDBFile, stateDir, statusFile } from '${join(ctx.repo, 'src', 'shared', 'config')}';

const home = join(process.env['ATC_TEST_HOME'] ?? '', 'home') + sep;

test('it resolves the config file, state directory, and status file under the home', () => {
  expect([configFile, stateDir, statusFile]).toSatisfyAll((path: string) => path.startsWith(home));
});

test('it resolves the databases and the legacy fleet file under the home', () => {
  expect([dbFile, mcpAuthDBFile, legacyFleetFile]).toSatisfyAll((path: string) => path.startsWith(home));
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it resolves every atc socket and the daemon record inside the run's own runtime directory", () => {
  const ctx = setupTest();
  const fixture = join(ctx.dir, 'runtime-paths.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { join, sep } from 'node:path';
import { daemonPidFile, daemonSocketPath, eventsSocketPath, socketPath } from '${join(ctx.repo, 'src', 'shared', 'config')}';

const runtime = join(process.env['ATC_TEST_HOME'] ?? '', 'runtime') + sep;

test('it resolves the reporter and daemon sockets under the runtime directory', () => {
  expect([socketPath, daemonSocketPath]).toSatisfyAll((path: string) => path.startsWith(runtime));
});

test('it resolves the events socket and the daemon record under the runtime directory', () => {
  expect([eventsSocketPath, daemonPidFile]).toSatisfyAll((path: string) => path.startsWith(runtime));
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it resolves the grok and codex homes inside the run's own home", () => {
  const ctx = setupTest();
  const fixture = join(ctx.dir, 'agent-homes.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveAgentHome } from '${join(ctx.repo, 'src', 'agents', 'resolve-agent-home')}';

const home = join(process.env['ATC_TEST_HOME'] ?? '', 'home');

test('it resolves the grok home under the home', () => {
  expect(resolveAgentHome('GROK_HOME', '.grok')).toBe(join(home, '.grok'));
});

test('it resolves the codex home under the home', () => {
  expect(resolveAgentHome('CODEX_HOME', '.codex')).toBe(join(home, '.codex'));
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it resolves the Claude config folder inside the run's own home", () => {
  const ctx = setupTest();
  const fixture = join(ctx.dir, 'claude-home.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveAgentHome } from '${join(ctx.repo, 'src', 'agents', 'resolve-agent-home')}';

test('it resolves the Claude config folder under the home', () => {
  expect(resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude')).toBe(
    join(process.env['ATC_TEST_HOME'] ?? '', 'home', '.claude'),
  );
});

test('it runs without an inherited Claude config folder', () => {
  expect(process.env).not.toContainKey('CLAUDE_CONFIG_DIR');
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(ctx.dir, 'claude') },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test('it runs with no enclosing atc session to report to', () => {
  const ctx = setupTest();
  const fixture = join(ctx.dir, 'no-session.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';

test('it runs without the session id', () => {
  expect(process.env).not.toContainKey('ATC_SESSION_ID');
});

test('it runs without the session socket', () => {
  expect(process.env).not.toContainKey('ATC_SOCKET');
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: { ...process.env, ATC_SESSION_ID: 's1-enclosing', ATC_SOCKET: join(ctx.dir, 'atc.sock') },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it resolves the XDG config, data, state, and cache homes inside the run's own home", () => {
  const ctx = setupTest();
  const fixture = join(ctx.dir, 'xdg.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';
import { join } from 'node:path';

const home = join(process.env['ATC_TEST_HOME'] ?? '', 'home');

test('it sets the XDG config and data homes under the home', () => {
  expect([process.env['XDG_CONFIG_HOME'], process.env['XDG_DATA_HOME']]).toStrictEqual([
    join(home, '.config'),
    join(home, '.local', 'share'),
  ]);
});

test('it sets the XDG state and cache homes under the home', () => {
  expect([process.env['XDG_STATE_HOME'], process.env['XDG_CACHE_HOME']]).toStrictEqual([
    join(home, '.local', 'state'),
    join(home, '.cache'),
  ]);
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test('it runs git in a test without the git config of the host XDG config home', () => {
  const ctx = setupTest();
  const host = join(ctx.dir, 'host-xdg');

  mkdirSync(join(host, 'git'), { recursive: true });
  writeFileSync(join(host, 'git', 'config'), '[atc]\n\tcanary = host\n');

  const fixture = join(ctx.dir, 'git-config.test.ts');

  writeFileSync(
    fixture,
    `import { expect, test } from 'bun:test';

test('it reads no value for the host canary key', () => {
  const read = Bun.spawnSync(['git', 'config', '--get', 'atc.canary'], { stdout: 'pipe', stderr: 'pipe' });

  expect(read.stdout.toString()).toBe('');
});

test('it finds no host canary key at all', () => {
  const read = Bun.spawnSync(['git', 'config', '--get', 'atc.canary'], { stdout: 'pipe', stderr: 'pipe' });

  expect(read.exitCode).toBe(1);
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: { ...process.env, XDG_CONFIG_HOME: host },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it writes a gateway's generated settings file inside the run's own home", () => {
  const ctx = setupTest();
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

  adapter.buildResumeCommand('${ctx.dir}', undefined);

  expect(realpathSync(join(stateDir, 'hook-settings-isolation-probe.json'))).toStartWith(
    realpathSync(join(process.env['ATC_TEST_HOME'] ?? '', 'home')) + sep,
  );
});

test('it holds the state directory under the home', () => {
  expect(stateDir).toStartWith(join(process.env['ATC_TEST_HOME'] ?? '', 'home') + sep);
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it writes the atc-bridge mod inside the run's own home by default", () => {
  const ctx = setupTest();
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

test('it writes the mod again to the same directory', () => {
  expect(writeATCBridge()).toBe(writeATCBridge());
});
`,
  );

  const nested = Bun.spawnSync(['bash', 'scripts/with-test-home.sh', 'bun', 'test', fixture], {
    cwd: ctx.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test("it puts back an environment override before the run's next test", () => {
  const ctx = setupTest();
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

  expect({ exitCode: nested.exitCode, summary: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    summary: expect.toInclude(' 2 pass\n 0 fail\n'),
  });
});

test('it stops a bare bun test before any test runs', () => {
  const ctx = setupTest();
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

  expect({
    exitCode: nested.exitCode,
    stdout: nested.stdout.toString(),
    stderr: nested.stderr.toString(),
  }).toStrictEqual({
    exitCode: 2,
    stdout: expect.not.toInclude('fixture test ran'),
    stderr: expect.toInclude('run `bun run test` instead'),
  });
});

test('it refuses to run under a test-home marker whose paths do not match it', () => {
  const ctx = setupTest();
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

  expect({
    exitCode: nested.exitCode,
    stdout: nested.stdout.toString(),
    stderr: nested.stderr.toString(),
  }).toStrictEqual({
    exitCode: 2,
    stdout: expect.not.toInclude('fixture test ran'),
    stderr: expect.toInclude('does not match the test home it marks'),
  });
});

test('it refuses to run under a test-home marker beside an enclosing atc session', () => {
  const ctx = setupTest();
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

  expect({
    exitCode: nested.exitCode,
    stdout: nested.stdout.toString(),
    stderr: nested.stderr.toString(),
  }).toStrictEqual({
    exitCode: 2,
    stdout: expect.not.toInclude('fixture test ran'),
    stderr: expect.toInclude('but ATC_SESSION_ID does not match the test home it marks'),
  });
});

test('it accepts the test home the package script sets up under a temp directory ending in a slash', () => {
  const ctx = setupTest();
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

  expect({ exitCode: nested.exitCode, stderr: nested.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    stderr: expect.toInclude(' 2 pass\n 0 fail\n'),
  });

  expect(nested.stdout.toString()).toMatch(/fixture test ran\n[\s\S]*fixture test ran\n/);
});
