import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../test-utils/run-command';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildCodexGuestLaunch } from './build-codex-guest-launch';

// The guest folder a launch stages its files under and runs in.
function setupTest() {
  const tmp = setupTempDir('atc-codex-launch-');

  return { dir: tmp.dir };
}

test('it copies the staged sign-in, config, and hooks into the Codex home and runs the CLI there', async () => {
  const ctx = setupTest();

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

  const run = await runCommand([launch.bin, ...launch.args], { env: { ...launch.env } });

  const home = join(ctx.dir, 'codex-home');

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: `${home}|resume c-1`,
  });

  expect(launch.env).toStrictEqual({ CODEX_HOME: home });
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"rev":"auth-r1"}');
  expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
  expect(statSync(home).mode & 0o777).toBe(0o700);

  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(
    'check_for_update_on_startup = false\n',
  );

  expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe('{"hooks":{}}');
});

test('it appends the clone trust seed to the config on every launch that finds one', async () => {
  const ctx = setupTest();

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

  await runCommand([first.bin, ...first.args]);

  const second = buildCodexGuestLaunch(ctx.dir, 'auth-r2', ['true']);

  const run = await runCommand([second.bin, ...second.args]);

  const home = join(ctx.dir, 'codex-home');

  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"rev":"auth-r2"}');

  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(
    'check_for_update_on_startup = false\n\n[projects."/work"]\ntrust_level = "trusted"\n',
  );
});

test('it unsets every variable that would sign Codex in another way', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'auth-r1'), { recursive: true });
  writeFileSync(join(ctx.dir, 'auth-r1', 'auth.json'), '{"rev":"auth-r1"}');
  writeFileSync(join(ctx.dir, 'auth-r1', 'config.toml'), 'check_for_update_on_startup = false\n');
  writeFileSync(join(ctx.dir, 'auth-r1', 'hooks.json'), '{"hooks":{}}');

  const launch = buildCodexGuestLaunch(ctx.dir, 'auth-r1', [
    'sh',
    '-c',
    'for v in OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN KEPT; do printf "%s," "$(printenv "$v" || echo unset)"; done',
  ]);

  const run = await runCommand([launch.bin, ...launch.args], {
    env: {
      OPENAI_API_KEY: 'sk-example',
      CODEX_API_KEY: 'sk-example',
      CODEX_ACCESS_TOKEN: 'example',
      KEPT: 'kept',
    },
  });

  expect(run.stdout).toBe('unset,unset,unset,kept,');
});

test('it stops before the CLI runs when the staged sign-in is missing', async () => {
  const ctx = setupTest();
  const launch = buildCodexGuestLaunch(ctx.dir, 'auth-r1', ['sh', '-c', 'echo ran']);

  const run = await runCommand([launch.bin, ...launch.args]);

  expect({ exitCode: run.exitCode, stdout: run.stdout }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
