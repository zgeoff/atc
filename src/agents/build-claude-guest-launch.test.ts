import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../test-utils/run-command';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildClaudeGuestLaunch } from './build-claude-guest-launch';

// The guest folder a launch stages its bundle under and runs in.
function setupTest() {
  const tmp = setupTempDir('atc-claude-launch-');

  return { dir: tmp.dir };
}

test("it replaces the config folder's bundle with the one each launch stages", async () => {
  const ctx = setupTest();
  const first = buildClaudeGuestLaunch(ctx.dir, ['true'], [], 'k1');
  const second = buildClaudeGuestLaunch(ctx.dir, ['true'], [], 'k2');
  const config = join(ctx.dir, 'claude-config');
  const staged = join(ctx.dir, 'claude-config-bundle');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'k1', 'skills', 'old-skill'), { recursive: true });
  writeFileSync(join(staged, 'k1', 'skills', 'old-skill', 'SKILL.md'), 'old');
  writeFileSync(join(staged, 'k1', 'settings.json'), '{"model":"opus"}');

  await runCommand([first.bin, ...first.args]);

  writeFileSync(join(config, '.claude.json'), '{"written":"by the CLI"}');
  mkdirSync(join(staged, 'k2', 'skills', 'new-skill'), { recursive: true });
  writeFileSync(join(staged, 'k2', 'skills', 'new-skill', 'SKILL.md'), 'new');
  writeFileSync(join(staged, 'k2', 'settings.json'), '{"model":"sonnet"}');

  const run = await runCommand([second.bin, ...second.args]);

  expect(run.exitCode).toBe(0);
  expect(existsSync(join(config, 'skills', 'old-skill'))).toBeFalse();
  expect(readFileSync(join(config, 'skills', 'new-skill', 'SKILL.md'), 'utf8')).toBe('new');
  expect(readFileSync(join(config, 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}');
  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe('{"written":"by the CLI"}');
  expect(existsSync(staged)).toBeFalse();
});

test('it never copies a bundle an earlier launch staged and left behind', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true'], [], 'current');
  const config = join(ctx.dir, 'claude-config');
  const staged = join(ctx.dir, 'claude-config-bundle');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'failed', 'skills', 'removed-skill'), { recursive: true });
  writeFileSync(join(staged, 'failed', 'skills', 'removed-skill', 'SKILL.md'), 'removed');
  mkdirSync(join(staged, 'current', 'skills', 'kept-skill'), { recursive: true });
  writeFileSync(join(staged, 'current', 'skills', 'kept-skill', 'SKILL.md'), 'kept');

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(existsSync(join(config, 'skills', 'removed-skill'))).toBeFalse();
  expect(existsSync(join(config, 'skills', 'kept-skill', 'SKILL.md'))).toBeTrue();
  expect(existsSync(staged)).toBeFalse();
});

test("it keeps the config folder's bundle when a launch stages none", async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);
  const config = join(ctx.dir, 'claude-config');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(config, 'skills', 'kept'), { recursive: true });
  writeFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'kept');

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'utf8')).toBe('kept');

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{"hasCompletedOnboarding":true}',
  );
});
