import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildCodexGuestLaunch } from './build-codex-guest-launch';

// The guest folder a launch stages its files under and runs in.
function setupTest() {
  return setupTempDir('atc-codex-launch-');
}

test('it copies the staged sign-in, config, and hooks into the Codex home and runs the CLI there', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'auth-r1'), { recursive: true });
  writeFileSync(join(ctx.dir, 'auth-r1', 'auth.json'), '{"rev":"auth-r1"}');
  writeFileSync(join(ctx.dir, 'auth-r1', 'config.toml'), 'check_for_update_on_startup = false\n');
  writeFileSync(join(ctx.dir, 'auth-r1', 'hooks.json'), '{"hooks":{}}');

  const launch = buildCodexGuestLaunch(ctx.dir, 'auth-r1', [
    'sh',
    '-c',
    'printf "%s|%s" "$CODEX_HOME" "$*"',
    'codex',
    'resume',
    'c-1',
  ]);

  const run = Bun.spawnSync([launch.bin, ...launch.args], { env: { ...launch.env } });
  const home = join(ctx.dir, 'codex-home');

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
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'auth-r1'), { recursive: true });
  writeFileSync(join(ctx.dir, 'auth-r1', 'auth.json'), '{"rev":"auth-r1"}');
  writeFileSync(join(ctx.dir, 'auth-r1', 'config.toml'), 'check_for_update_on_startup = false\n');
  writeFileSync(join(ctx.dir, 'auth-r1', 'hooks.json'), '{"hooks":{}}');
  mkdirSync(join(ctx.dir, 'auth-r2'), { recursive: true });
  writeFileSync(join(ctx.dir, 'auth-r2', 'auth.json'), '{"rev":"auth-r2"}');
  writeFileSync(join(ctx.dir, 'auth-r2', 'config.toml'), 'check_for_update_on_startup = false\n');
  writeFileSync(join(ctx.dir, 'auth-r2', 'hooks.json'), '{"hooks":{}}');

  writeFileSync(
    join(ctx.dir, 'codex-trust.toml'),
    '\n[projects."/work"]\ntrust_level = "trusted"\n',
  );

  const first = buildCodexGuestLaunch(ctx.dir, 'auth-r1', ['true']);

  Bun.spawnSync([first.bin, ...first.args]);

  const second = buildCodexGuestLaunch(ctx.dir, 'auth-r2', ['true']);
  const run = Bun.spawnSync([second.bin, ...second.args]);
  const home = join(ctx.dir, 'codex-home');

  expect({
    exitCode: run.exitCode,
    auth: readFileSync(join(home, 'auth.json'), 'utf8'),
    config: readFileSync(join(home, 'config.toml'), 'utf8'),
  }).toStrictEqual({
    exitCode: 0,
    auth: '{"rev":"auth-r2"}',
    config: 'check_for_update_on_startup = false\n\n[projects."/work"]\ntrust_level = "trusted"\n',
  });
});

test('it unsets every variable that would sign Codex in another way', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'auth-r1'), { recursive: true });
  writeFileSync(join(ctx.dir, 'auth-r1', 'auth.json'), '{"rev":"auth-r1"}');
  writeFileSync(join(ctx.dir, 'auth-r1', 'config.toml'), 'check_for_update_on_startup = false\n');
  writeFileSync(join(ctx.dir, 'auth-r1', 'hooks.json'), '{"hooks":{}}');

  const launch = buildCodexGuestLaunch(ctx.dir, 'auth-r1', [
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
  using ctx = setupTest();

  const launch = buildCodexGuestLaunch(ctx.dir, 'auth-r1', ['sh', '-c', 'echo ran']);
  const run = Bun.spawnSync([launch.bin, ...launch.args]);

  expect({ exitCode: run.exitCode, stdout: run.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
