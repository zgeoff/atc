import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { loadClaudeConfigBundle } from './load-claude-config-bundle';

// The folder the host's Claude config folder and its symlink targets sit in.
function setupTest() {
  return setupTempDir('atc-claude-bundle-');
}

test('it ships the allow-listed files and folders of the host config folder', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, '.claude');

  mkdirSync(join(host, 'agents'), { recursive: true });
  mkdirSync(join(host, 'output-styles'), { recursive: true });
  mkdirSync(join(host, 'skills', 'delegate', 'references'), { recursive: true });
  mkdirSync(join(host, 'projects', 'p1'), { recursive: true });
  writeFileSync(join(host, 'CLAUDE.md'), '# rules');
  writeFileSync(join(host, 'statusline.sh'), 'echo status');
  writeFileSync(join(host, 'settings.json'), JSON.stringify({ model: 'opus' }));
  writeFileSync(join(host, 'agents', 'locator.md'), 'locator');
  writeFileSync(join(host, 'output-styles', 'ste-direct.md'), 'style');
  writeFileSync(join(host, 'skills', 'delegate', 'SKILL.md'), 'delegate');
  writeFileSync(join(host, 'skills', 'delegate', 'references', 'cli.md'), 'cli');
  writeFileSync(join(host, 'history.jsonl'), '{}');
  writeFileSync(join(host, 'settings.json.bak'), '{}');
  writeFileSync(join(host, 'projects', 'p1', 'transcript.jsonl'), '{}');

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config', join(ctx.dir, 'home'));

  expect(bundle).toStrictEqual({
    'CLAUDE.md': Buffer.from('# rules'),
    'agents/locator.md': Buffer.from('locator'),
    'output-styles/ste-direct.md': Buffer.from('style'),
    'settings.json': JSON.stringify(
      { model: 'opus', permissions: { defaultMode: 'auto' } },
      null,
      2,
    ),
    'skills/delegate/SKILL.md': Buffer.from('delegate'),
    'skills/delegate/references/cli.md': Buffer.from('cli'),
    'statusline.sh': Buffer.from('echo status'),
  });
});

test('it never ships credentials, account state, or a secret the host env block holds', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, '.claude');

  mkdirSync(join(host, 'skills', 'delegate'), { recursive: true });
  writeFileSync(join(host, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"oat-secret"}}');
  writeFileSync(join(host, '.claude.json'), '{"oauthAccount":{"emailAddress":"acct-secret"}}');
  writeFileSync(join(host, 'skills', 'delegate', 'SKILL.md'), 'delegate');
  writeFileSync(join(host, 'skills', 'delegate', '.env'), 'TOKEN=dotenv-secret');

  writeFileSync(
    join(host, 'settings.json'),
    JSON.stringify({
      env: {
        GITHUB_TOKEN: 'ghp-secret',
        OP_SERVICE_ACCOUNT_TOKEN: 'ops-secret',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
      apiKeyHelper: 'echo helper-secret',
    }),
  );

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config', join(ctx.dir, 'home'));

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify(
      {
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
        permissions: { defaultMode: 'auto' },
      },
      null,
      2,
    ),
    'skills/delegate/SKILL.md': Buffer.from('delegate'),
  });
});

test('it copies a symlinked skill and leaves out a skills folder without a SKILL.md', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, '.claude');
  const shared = join(ctx.dir, 'shared-skills', 'gh-stack');

  mkdirSync(join(host, 'skills', 'synced', 'abc', 'docx'), { recursive: true });
  mkdirSync(join(shared, 'references'), { recursive: true });
  writeFileSync(join(shared, 'SKILL.md'), 'stack');
  writeFileSync(join(shared, 'references', 'commands.md'), 'commands');
  writeFileSync(join(host, 'skills', 'synced', 'abc', 'docx', 'SKILL.md'), 'docx');
  symlinkSync(shared, join(host, 'skills', 'gh-stack'));
  symlinkSync(join(ctx.dir, 'missing'), join(host, 'skills', 'dangling'));

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config', join(ctx.dir, 'home'));

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2),
    'skills/gh-stack/SKILL.md': Buffer.from('stack'),
    'skills/gh-stack/references/commands.md': Buffer.from('commands'),
  });
});

test('it never ships a symlink that resolves to credentials, account state, or the unfiltered settings', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, '.claude');
  const skill = join(host, 'skills', 'leaky');

  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'leaky');
  writeFileSync(join(host, '.credentials.json'), '{"token":"oat-secret"}');
  writeFileSync(join(host, 'settings.json'), '{"env":{"GITHUB_TOKEN":"ghp-secret"}}');
  writeFileSync(join(host, 'history.jsonl'), '{"display":"history-secret"}');
  writeFileSync(join(ctx.dir, '.claude.json'), '{"oauthAccount":"acct-secret"}');
  writeFileSync(join(ctx.dir, 'notes.md'), 'shared notes');
  symlinkSync(join(host, '.credentials.json'), join(skill, 'credentials'));
  symlinkSync(join(host, 'settings.json'), join(skill, 'settings'));
  symlinkSync(join(host, 'history.jsonl'), join(skill, 'history'));
  symlinkSync(join(ctx.dir, '.claude.json'), join(skill, 'account'));
  symlinkSync(join(ctx.dir, 'notes.md'), join(skill, 'notes.md'));

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config', join(ctx.dir, 'home'));

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2),
    'skills/leaky/SKILL.md': Buffer.from('leaky'),
    'skills/leaky/notes.md': Buffer.from('shared notes'),
  });
});

test('it ends a symlink that loops back up a skill folder', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, '.claude');
  const skill = join(host, 'skills', 'looped');

  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'looped');
  symlinkSync(skill, join(skill, 'again'));

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config', join(ctx.dir, 'home'));

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2),
    'skills/looped/SKILL.md': Buffer.from('looped'),
  });
});

test('it ships an executable file with an executable mode and any other file as bytes', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, '.claude');

  mkdirSync(join(host, 'skills', 'tool', 'scripts'), { recursive: true });
  writeFileSync(join(host, 'statusline.sh'), 'echo status');
  writeFileSync(join(host, 'skills', 'tool', 'SKILL.md'), 'tool');
  writeFileSync(join(host, 'skills', 'tool', 'scripts', 'run.sh'), 'echo run');
  chmodSync(join(host, 'statusline.sh'), 0o700);
  chmodSync(join(host, 'skills', 'tool', 'scripts', 'run.sh'), 0o755);

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config', join(ctx.dir, 'home'));

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2),
    'statusline.sh': { content: Buffer.from('echo status'), mode: 0o755 },
    'skills/tool/SKILL.md': Buffer.from('tool'),
    'skills/tool/scripts/run.sh': { content: Buffer.from('echo run'), mode: 0o755 },
  });
});

test("it points a home-relative statusline at the guest when the host folder is the home's own", () => {
  using ctx = setupTest();

  const host = join(ctx.dir, '.claude');

  mkdirSync(host, { recursive: true });

  writeFileSync(
    join(host, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline.sh' } }),
  );

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config', ctx.dir);

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify(
      {
        statusLine: { type: 'command', command: 'bash /guest/claude-config/statusline.sh' },
        permissions: { defaultMode: 'auto' },
      },
      null,
      2,
    ),
  });
});

test('it ships auto mode alone when the host has no Claude config folder', () => {
  using ctx = setupTest();

  const bundle = loadClaudeConfigBundle(
    join(ctx.dir, 'missing'),
    '/guest/claude-config',
    join(ctx.dir, 'home'),
  );

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2),
  });
});
