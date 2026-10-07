import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildCodexGuestLaunch } from './build-codex-guest-launch';

// Stages the files a guest plan transfers under a revision's folder.
function setupStaged(dir: string, revision: string): void {
  mkdirSync(join(dir, revision), { recursive: true });
  writeFileSync(join(dir, revision, 'auth.json'), `{"rev":"${revision}"}`);
  writeFileSync(join(dir, revision, 'config.toml'), 'check_for_update_on_startup = false\n');
  writeFileSync(join(dir, revision, 'hooks.json'), '{"hooks":{}}');
}

test('it copies the staged sign-in, config, and hooks into the Codex home and runs the CLI there', () => {
  using tmp = setupTempDir('atc-codex-launch-');

  setupStaged(tmp.dir, 'auth-r1');

  const launch = buildCodexGuestLaunch(tmp.dir, 'auth-r1', [
    'sh',
    '-c',
    'printf "%s|%s" "$CODEX_HOME" "$*"',
    'codex',
    'resume',
    'c-1',
  ]);

  const run = Bun.spawnSync([launch.bin, ...launch.args], { env: { ...launch.env } });
  const home = join(tmp.dir, 'codex-home');

  expect({
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    env: launch.env,
    auth: readFileSync(join(home, 'auth.json'), 'utf8'),
    authMode: statSync(join(home, 'auth.json')).mode & 0o777,
    homeMode: statSync(home).mode & 0o777,
    config: readFileSync(join(home, 'config.toml'), 'utf8'),
    hooks: readFileSync(join(home, 'hooks.json'), 'utf8'),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `${home}|resume c-1`,
    env: { CODEX_HOME: home },
    auth: '{"rev":"auth-r1"}',
    authMode: 0o600,
    homeMode: 0o700,
    config: 'check_for_update_on_startup = false\n',
    hooks: '{"hooks":{}}',
  });
});

test('it appends the clone trust seed to the config on every launch that finds one', () => {
  using tmp = setupTempDir('atc-codex-launch-');

  setupStaged(tmp.dir, 'auth-r1');
  setupStaged(tmp.dir, 'auth-r2');

  writeFileSync(
    join(tmp.dir, 'codex-trust.toml'),
    '\n[projects."/work"]\ntrust_level = "trusted"\n',
  );

  const first = buildCodexGuestLaunch(tmp.dir, 'auth-r1', ['true']);
  const second = buildCodexGuestLaunch(tmp.dir, 'auth-r2', ['true']);

  const runs = [first, second].map(
    (launch) => Bun.spawnSync([launch.bin, ...launch.args]).exitCode,
  );

  const home = join(tmp.dir, 'codex-home');

  expect({
    runs,
    auth: readFileSync(join(home, 'auth.json'), 'utf8'),
    config: readFileSync(join(home, 'config.toml'), 'utf8'),
  }).toStrictEqual({
    runs: [0, 0],
    auth: '{"rev":"auth-r2"}',
    config: 'check_for_update_on_startup = false\n\n[projects."/work"]\ntrust_level = "trusted"\n',
  });
});

test('it unsets every variable that would sign Codex in another way', () => {
  using tmp = setupTempDir('atc-codex-launch-');

  setupStaged(tmp.dir, 'auth-r1');

  const launch = buildCodexGuestLaunch(tmp.dir, 'auth-r1', [
    'sh',
    '-c',
    'for v in OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN KEPT; do printf "%s," "$(printenv "$v" || echo unset)"; done',
  ]);

  const run = Bun.spawnSync([launch.bin, ...launch.args], {
    env: {
      OPENAI_API_KEY: 'sk-example',
      CODEX_API_KEY: 'sk-example',
      CODEX_ACCESS_TOKEN: 'example',
      KEPT: 'kept',
    },
  });

  expect(run.stdout.toString()).toBe('unset,unset,unset,kept,');
});

test('it stops before the CLI runs when the staged sign-in is missing', () => {
  using tmp = setupTempDir('atc-codex-launch-');

  const launch = buildCodexGuestLaunch(tmp.dir, 'auth-r1', ['sh', '-c', 'echo ran']);
  const run = Bun.spawnSync([launch.bin, ...launch.args]);

  expect({ failed: run.exitCode !== 0, stdout: run.stdout.toString() }).toStrictEqual({
    failed: true,
    stdout: '',
  });
});
