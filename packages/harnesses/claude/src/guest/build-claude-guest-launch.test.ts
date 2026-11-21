import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { buildClaudeGuestLaunch } from './build-claude-guest-launch';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-claude-launch-');

  return { directory: temporaryDirectory.path };
}

test("it replaces the config folder's bundle with the one each launch stages", async () => {
  const ctx = setupTest();
  const first = buildClaudeGuestLaunch(ctx.directory, ['true'], { bundleKey: 'k1' });
  const second = buildClaudeGuestLaunch(ctx.directory, ['true'], { bundleKey: 'k2' });
  const config = join(ctx.directory, 'claude-config');
  const staged = join(ctx.directory, 'claude-config-bundle');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'k1', 'skills', 'old-skill'), { recursive: true });
  writeFileSync(join(staged, 'k1', 'skills', 'old-skill', 'SKILL.md'), 'old');
  writeFileSync(join(staged, 'k1', 'settings.json'), '{"model":"opus"}');

  await run([first.bin, ...first.args]);

  writeFileSync(join(config, '.claude.json'), '{"written":"by the CLI"}');
  mkdirSync(join(staged, 'k2', 'skills', 'new-skill'), { recursive: true });
  writeFileSync(join(staged, 'k2', 'skills', 'new-skill', 'SKILL.md'), 'new');
  writeFileSync(join(staged, 'k2', 'settings.json'), '{"model":"sonnet"}');

  const result = await run([second.bin, ...second.args]);

  expect(result.exitCode).toBe(0);
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

test("it replaces the config folder's credentials file with the staged one and its mode", async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true'], { bundleKey: 'k1' });
  const config = join(ctx.directory, 'claude-config');
  const staged = join(ctx.directory, 'claude-config-bundle', 'k1');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, '.credentials.json'), '{"written":"by the CLI"}', { mode: 0o644 });
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, '.credentials.json'), '{"staged":true}', { mode: 0o600 });

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(config, '.credentials.json'), 'utf8')).toBe('{"staged":true}');
  expect(statSync(join(config, '.credentials.json')).mode & 0o777).toBe(0o600);
});

test('it never copies a bundle an earlier launch staged and left behind', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true'], { bundleKey: 'current' });
  const config = join(ctx.directory, 'claude-config');
  const staged = join(ctx.directory, 'claude-config-bundle');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  mkdirSync(join(staged, 'failed', 'skills', 'removed-skill'), { recursive: true });
  writeFileSync(join(staged, 'failed', 'skills', 'removed-skill', 'SKILL.md'), 'removed');
  mkdirSync(join(staged, 'current', 'skills', 'kept-skill'), { recursive: true });
  writeFileSync(join(staged, 'current', 'skills', 'kept-skill', 'SKILL.md'), 'kept');

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(config, 'skills', 'removed-skill'))).toBeFalse();
  expect(existsSync(join(config, 'skills', 'kept-skill', 'SKILL.md'))).toBeTrue();
  expect(existsSync(staged)).toBeFalse();
});

test("it keeps the config folder's bundle when a launch stages none", async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true']);
  const config = join(ctx.directory, 'claude-config');

  writeFileSync(
    join(ctx.directory, 'claude-config-seed.json'),
    '{"hasCompletedOnboarding":true,"hasSeenAutoModeOutsideReadPrompt":true}',
  );

  mkdirSync(join(config, 'skills', 'kept'), { recursive: true });
  writeFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'kept');

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(config, 'skills', 'kept', 'SKILL.md'), 'utf8')).toBe('kept');

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{"hasCompletedOnboarding":true,"hasSeenAutoModeOutsideReadPrompt":true}',
  );
});

test('it creates the scratch folder, readable by its owner alone, before the CLI runs', async () => {
  const ctx = setupTest();
  const scratch = join(ctx.directory, 'scratch');
  const launch = buildClaudeGuestLaunch(ctx.directory, ['test', '-d', scratch]);

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);
  expect(statSync(scratch).mode & 0o777).toBe(0o700);
});

test('it takes an existing scratch folder back to its owner alone', async () => {
  const ctx = setupTest();
  const scratch = join(ctx.directory, 'scratch');
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true']);

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');
  mkdirSync(scratch);
  chmodSync(scratch, 0o755);

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);
  expect(statSync(scratch).mode & 0o777).toBe(0o700);
});

test('it starts the CLI with a warning when it cannot mark the outside-read offer seen', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true']);
  const config = join(ctx.directory, 'claude-config');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');
  mkdirSync(config);
  writeFileSync(join(config, '.claude.json'), '\n{"numStartups":1}\n');

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);

  expect(result.stderr).toBe(
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
  const out = join(ctx.directory, 'argv.txt');

  const launch = buildClaudeGuestLaunch(ctx.directory, [
    'sh',
    '-c',
    String.raw`printf "%s\n" "$@" > "$0"`,
    out,
    '--add-dir',
    'a dir',
  ]);

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe('--add-dir\na dir\n');
});

test('it runs the CLI without the variables it unsets', async () => {
  const ctx = setupTest();
  const out = join(ctx.directory, 'env.txt');

  const launch = buildClaudeGuestLaunch(
    ctx.directory,
    [
      'sh',
      '-c',
      'for name in CODEX_API_KEY OPENAI_API_KEY KEPT; do printenv "$name" || echo unset; done > "$0"',
      out,
    ],
    { unsetEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'] },
  );

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');

  const result = await run([launch.bin, ...launch.args], {
    env: {
      PATH: process.env['PATH'],
      CODEX_API_KEY: 'test-codex-key',
      OPENAI_API_KEY: 'test-openai-key',
      KEPT: 'kept',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe('unset\nunset\nkept\n');
});

test("it adds the outside-read offer's seen mark to the config an earlier run left", async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true']);
  const config = join(ctx.directory, 'claude-config');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');
  mkdirSync(config);

  writeFileSync(
    join(config, '.claude.json'),
    '{\n  "numStartups": 4,\n  "projects": {\n    "/work": {\n      "hasTrustDialogAccepted": true\n    }\n  }\n}\n',
  );

  const result = await run([launch.bin, ...launch.args]);

  const merged: unknown = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8'));

  expect(result.exitCode).toBe(0);

  expect(merged).toStrictEqual({
    hasSeenAutoModeOutsideReadPrompt: true,
    numStartups: 4,
    projects: { '/work': { hasTrustDialogAccepted: true } },
  });
});

test('it turns a false outside-read offer mark true in the config an earlier run left', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true']);
  const config = join(ctx.directory, 'claude-config');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');
  mkdirSync(config);

  writeFileSync(
    join(config, '.claude.json'),
    '{\n  "numStartups": 4,\n  "hasSeenAutoModeOutsideReadPrompt": false\n}\n',
  );

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{\n  "numStartups": 4,\n  "hasSeenAutoModeOutsideReadPrompt": true\n}\n',
  );
});

test('it turns a false outside-read offer mark true when a space precedes its colon', async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true']);
  const config = join(ctx.directory, 'claude-config');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');
  mkdirSync(config);
  writeFileSync(join(config, '.claude.json'), '{"hasSeenAutoModeOutsideReadPrompt" : false}');

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(config, '.claude.json'), 'utf8')).toBe(
    '{"hasSeenAutoModeOutsideReadPrompt": true}',
  );
});

test("it adds the outside-read offer's seen mark to an empty config an earlier run left", async () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['true']);
  const config = join(ctx.directory, 'claude-config');

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{}');
  mkdirSync(config);
  writeFileSync(join(config, '.claude.json'), '{}\n');

  const result = await run([launch.bin, ...launch.args]);

  const merged: unknown = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8'));

  expect(result.exitCode).toBe(0);
  expect(merged).toStrictEqual({ hasSeenAutoModeOutsideReadPrompt: true });
});

test('it starts the command with the token the file holds in its environment alone', async () => {
  const ctx = setupTest();
  const tokenFile = join(ctx.directory, 'claude-oauth-token');

  const launch = buildClaudeGuestLaunch(
    ctx.directory,
    ['sh', '-c', 'printf %s "$CLAUDE_CODE_OAUTH_TOKEN"'],
    { tokenFile },
  );

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');
  writeFileSync(tokenFile, 'not-a-real-token\n');

  const result = await run([launch.bin, ...launch.args], {
    env: { PATH: process.env['PATH'] },
  });

  expect(result.stdout).toBe('not-a-real-token');
});

test('it passes the shell the token file and no variable that holds the token', () => {
  const ctx = setupTest();
  const launch = buildClaudeGuestLaunch(ctx.directory, ['claude'], { tokenFile: '/sign-in/token' });

  expect(launch.args).toContain('/sign-in/token');

  expect(launch.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: `${ctx.directory}/claude-config`,
    TMPDIR: `${ctx.directory}/scratch`,
  });
});

test('it refuses to start the command when the token file is missing', async () => {
  const ctx = setupTest();

  const launch = buildClaudeGuestLaunch(ctx.directory, ['true'], {
    tokenFile: join(ctx.directory, 'no-such-token'),
  });

  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), '{"hasCompletedOnboarding":true}');

  const result = await run([launch.bin, ...launch.args]);

  expect(result.exitCode).toBe(78);
});
