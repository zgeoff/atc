import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildClaudeGuestLaunch } from './build-claude-guest-launch';

// The guest folder a launch stages its bundle under and runs in.
function setupTest() {
  return setupTempDir('atc-claude-launch-');
}

test("it replaces the config folder's bundle with the one each launch stages", () => {
  using ctx = setupTest();

  const first = buildClaudeGuestLaunch(ctx.dir, ['true'], [], 'k1');
  const second = buildClaudeGuestLaunch(ctx.dir, ['true'], [], 'k2');
  const config = join(ctx.dir, 'claude-config');
  const staged = join(ctx.dir, 'claude-config-bundle');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'k1', 'skills', 'old-skill'), { recursive: true });
  writeFileSync(join(staged, 'k1', 'skills', 'old-skill', 'SKILL.md'), 'old');
  writeFileSync(join(staged, 'k1', 'settings.json'), '{"model":"opus"}');

  Bun.spawnSync([first.bin, ...first.args]);

  writeFileSync(join(config, '.claude.json'), '{"written":"by the CLI"}');
  mkdirSync(join(staged, 'k2', 'skills', 'new-skill'), { recursive: true });
  writeFileSync(join(staged, 'k2', 'skills', 'new-skill', 'SKILL.md'), 'new');
  writeFileSync(join(staged, 'k2', 'settings.json'), '{"model":"sonnet"}');

  const run = Bun.spawnSync([second.bin, ...second.args]);

  expect({
    exitCode: run.exitCode,
    oldSkill: existsSync(join(config, 'skills', 'old-skill')),
    newSkill: readFileSync(join(config, 'skills', 'new-skill', 'SKILL.md'), 'utf8'),
    settings: readFileSync(join(config, 'settings.json'), 'utf8'),
    state: readFileSync(join(config, '.claude.json'), 'utf8'),
    staged: existsSync(staged),
  }).toStrictEqual({
    exitCode: 0,
    oldSkill: false,
    newSkill: 'new',
    settings: '{"model":"sonnet"}',
    state: '{"written":"by the CLI"}',
    staged: false,
  });
});

test('it never copies a bundle an earlier launch staged and left behind', () => {
  using ctx = setupTest();

  const launch = buildClaudeGuestLaunch(ctx.dir, ['true'], [], 'current');
  const config = join(ctx.dir, 'claude-config');
  const staged = join(ctx.dir, 'claude-config-bundle');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'failed', 'skills', 'removed-skill'), { recursive: true });
  writeFileSync(join(staged, 'failed', 'skills', 'removed-skill', 'SKILL.md'), 'removed');
  mkdirSync(join(staged, 'current', 'skills', 'kept-skill'), { recursive: true });
  writeFileSync(join(staged, 'current', 'skills', 'kept-skill', 'SKILL.md'), 'kept');

  const run = Bun.spawnSync([launch.bin, ...launch.args]);

  expect({
    exitCode: run.exitCode,
    removed: existsSync(join(config, 'skills', 'removed-skill')),
    kept: existsSync(join(config, 'skills', 'kept-skill', 'SKILL.md')),
    staged: existsSync(staged),
  }).toStrictEqual({ exitCode: 0, removed: false, kept: true, staged: false });
});

test("it keeps the config folder's bundle when a launch stages none", () => {
  using ctx = setupTest();

  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);
  const config = join(ctx.dir, 'claude-config');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(config, 'skills', 'kept'), { recursive: true });
  writeFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'kept');

  const run = Bun.spawnSync([launch.bin, ...launch.args]);

  expect({
    exitCode: run.exitCode,
    skill: readFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'utf8'),
    state: readFileSync(join(config, '.claude.json'), 'utf8'),
  }).toStrictEqual({ exitCode: 0, skill: 'kept', state: '{"hasCompletedOnboarding":true}' });
});
