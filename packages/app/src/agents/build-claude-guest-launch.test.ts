import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils/run-command';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
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

  const written: unknown = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8'));

  expect(written).toStrictEqual({
    hasSeenAutoModeOutsideReadPrompt: true,
    written: 'by the CLI',
  });

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

  writeFileSync(
    join(ctx.dir, 'claude-config-seed.json'),
    '{"hasCompletedOnboarding":true,"hasSeenAutoModeOutsideReadPrompt":true}',
  );

  mkdirSync(join(config, 'skills', 'kept'), { recursive: true });
  writeFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'kept');

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'utf8')).toBe('kept');

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{"hasCompletedOnboarding":true,"hasSeenAutoModeOutsideReadPrompt":true}',
  );
});

test('it creates the scratch folder, readable by its owner alone, before the CLI runs', async () => {
  const ctx = setupTest();
  const scratch = join(ctx.dir, 'scratch');
  const launch = buildClaudeGuestLaunch(ctx.dir, ['test', '-d', scratch]);

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(statSync(scratch).mode & 0o777).toBe(0o700);
});

test('it takes an existing scratch folder back to its owner alone', async () => {
  const ctx = setupTest();
  const scratch = join(ctx.dir, 'scratch');
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');
  mkdirSync(scratch);
  chmodSync(scratch, 0o755);

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(statSync(scratch).mode & 0o777).toBe(0o700);
});

test('it starts the CLI with a warning when it cannot mark the outside-read offer seen', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);
  const config = join(ctx.dir, 'claude-config');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');
  mkdirSync(config);
  writeFileSync(join(config, '.claude.json'), '\n{"numStartups":1}\n');

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);

  expect(run.stderr).toBe(
    `atc: could not mark the outside-read offer seen in ${config}/.claude.json, so Claude may stop to ask once\n`,
  );
});

test('it gives the CLI the scratch folder as its temporary folder and the config folder as its own', () => {
  const launch = buildClaudeGuestLaunch('/tmp/atc/sessions/s1', ['claude']);

  expect(launch.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
  });
});

test('it runs the CLI with its own arguments after the setup steps', async () => {
  const ctx = setupTest();
  const out = join(ctx.dir, 'argv.txt');

  const launch = buildClaudeGuestLaunch(ctx.dir, [
    'sh',
    '-c',
    String.raw`printf "%s\n" "$@" > "$0"`,
    out,
    '--add-dir',
    'a dir',
  ]);

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe('--add-dir\na dir\n');
});

test("it adds the outside-read offer's seen mark to the config an earlier run left", async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);
  const config = join(ctx.dir, 'claude-config');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');
  mkdirSync(config);

  writeFileSync(
    join(config, '.claude.json'),
    '{\n  "numStartups": 4,\n  "projects": {\n    "/work": {\n      "hasTrustDialogAccepted": true\n    }\n  }\n}\n',
  );

  const run = await runCommand([launch.bin, ...launch.args]);

  const merged: unknown = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8'));

  expect(run.exitCode).toBe(0);

  expect(merged).toStrictEqual({
    hasSeenAutoModeOutsideReadPrompt: true,
    numStartups: 4,
    projects: { '/work': { hasTrustDialogAccepted: true } },
  });
});

test('it turns a false outside-read offer mark true in the config an earlier run left', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);
  const config = join(ctx.dir, 'claude-config');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');
  mkdirSync(config);

  writeFileSync(
    join(config, '.claude.json'),
    '{\n  "numStartups": 4,\n  "hasSeenAutoModeOutsideReadPrompt": false\n}\n',
  );

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{\n  "numStartups": 4,\n  "hasSeenAutoModeOutsideReadPrompt": true\n}\n',
  );
});

test('it turns a false outside-read offer mark true when a space precedes its colon', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);
  const config = join(ctx.dir, 'claude-config');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');
  mkdirSync(config);
  writeFileSync(join(config, '.claude.json'), '{"hasSeenAutoModeOutsideReadPrompt" : false}');

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{"hasSeenAutoModeOutsideReadPrompt": true}',
  );
});

test("it adds the outside-read offer's seen mark to an empty config an earlier run left", async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.dir, ['true']);
  const config = join(ctx.dir, 'claude-config');

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), '{}');
  mkdirSync(config);
  writeFileSync(join(config, '.claude.json'), '{}\n');

  const run = await runCommand([launch.bin, ...launch.args]);

  const merged: unknown = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8'));

  expect(run.exitCode).toBe(0);
  expect(merged).toStrictEqual({ hasSeenAutoModeOutsideReadPrompt: true });
});
