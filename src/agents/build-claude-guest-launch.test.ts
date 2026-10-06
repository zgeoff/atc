import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { buildClaudeGuestLaunch } from './build-claude-guest-launch';

test("it replaces the config folder's bundle with the one each launch stages", () => {
  using tmp = setupTempDir('atc-claude-launch-');

  const first = buildClaudeGuestLaunch(tmp.dir, ['true'], [], 'k1');
  const second = buildClaudeGuestLaunch(tmp.dir, ['true'], [], 'k2');
  const config = join(tmp.dir, 'claude-config');
  const staged = join(tmp.dir, 'claude-config-bundle');

  writeFileSync(join(tmp.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'k1', 'skills', 'old-skill'), { recursive: true });
  writeFileSync(join(staged, 'k1', 'skills', 'old-skill', 'SKILL.md'), 'old');
  writeFileSync(join(staged, 'k1', 'settings.json'), '{"model":"opus"}');

  const firstRun = Bun.spawnSync([first.bin, ...first.args]);

  writeFileSync(join(config, '.claude.json'), '{"written":"by the CLI"}');
  mkdirSync(join(staged, 'k2', 'skills', 'new-skill'), { recursive: true });
  writeFileSync(join(staged, 'k2', 'skills', 'new-skill', 'SKILL.md'), 'new');
  writeFileSync(join(staged, 'k2', 'settings.json'), '{"model":"sonnet"}');

  const secondRun = Bun.spawnSync([second.bin, ...second.args]);

  expect([firstRun.exitCode, secondRun.exitCode]).toStrictEqual([0, 0]);

  expect({
    oldSkill: existsSync(join(config, 'skills', 'old-skill')),
    newSkill: readFileSync(join(config, 'skills', 'new-skill', 'SKILL.md'), 'utf8'),
    settings: readFileSync(join(config, 'settings.json'), 'utf8'),
    state: readFileSync(join(config, '.claude.json'), 'utf8'),
    staged: existsSync(staged),
  }).toStrictEqual({
    oldSkill: false,
    newSkill: 'new',
    settings: '{"model":"sonnet"}',
    state: '{"written":"by the CLI"}',
    staged: false,
  });
});

test('it never copies a bundle an earlier launch staged and left behind', () => {
  using tmp = setupTempDir('atc-claude-launch-');

  const launch = buildClaudeGuestLaunch(tmp.dir, ['true'], [], 'current');
  const config = join(tmp.dir, 'claude-config');
  const staged = join(tmp.dir, 'claude-config-bundle');

  writeFileSync(join(tmp.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'failed', 'skills', 'removed-skill'), { recursive: true });
  writeFileSync(join(staged, 'failed', 'skills', 'removed-skill', 'SKILL.md'), 'removed');
  mkdirSync(join(staged, 'current', 'skills', 'kept-skill'), { recursive: true });
  writeFileSync(join(staged, 'current', 'skills', 'kept-skill', 'SKILL.md'), 'kept');

  const run = Bun.spawnSync([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);

  expect({
    removed: existsSync(join(config, 'skills', 'removed-skill')),
    kept: existsSync(join(config, 'skills', 'kept-skill', 'SKILL.md')),
    staged: existsSync(staged),
  }).toStrictEqual({ removed: false, kept: true, staged: false });
});

test("it keeps the config folder's bundle when a launch stages none", () => {
  using tmp = setupTempDir('atc-claude-launch-');

  const launch = buildClaudeGuestLaunch(tmp.dir, ['true']);
  const config = join(tmp.dir, 'claude-config');

  writeFileSync(join(tmp.dir, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(config, 'skills', 'kept'), { recursive: true });
  writeFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'kept');

  const run = Bun.spawnSync([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'utf8')).toBe('kept');

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{"hasCompletedOnboarding":true}',
  );
});
