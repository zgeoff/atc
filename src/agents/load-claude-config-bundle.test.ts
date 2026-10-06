import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { loadClaudeConfigBundle } from './load-claude-config-bundle';

test('it ships the allow-listed files and folders of the host config folder', () => {
  using tmp = setupTempDir('atc-claude-bundle-');

  const host = join(tmp.dir, '.claude');

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

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config');

  expect(Object.keys(bundle).toSorted()).toStrictEqual([
    'CLAUDE.md',
    'agents/locator.md',
    'output-styles/ste-direct.md',
    'settings.json',
    'skills/delegate/SKILL.md',
    'skills/delegate/references/cli.md',
    'statusline.sh',
  ]);

  const rules = bundle['CLAUDE.md'];

  if (rules === undefined) {
    throw new Error('expected CLAUDE.md in the bundle');
  }

  expect(Buffer.from(rules).toString()).toBe('# rules');
});

test('it never ships credentials, account state, or a secret the host env block holds', () => {
  using tmp = setupTempDir('atc-claude-bundle-');

  const host = join(tmp.dir, '.claude');

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

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config');

  const text = Object.values(bundle)
    .map((content) => Buffer.from(content).toString())
    .join('\n');

  const settings = bundle['settings.json'];

  if (settings === undefined) {
    throw new Error('expected settings.json in the bundle');
  }

  expect(Object.keys(bundle).toSorted()).toStrictEqual([
    'settings.json',
    'skills/delegate/SKILL.md',
  ]);

  for (const secret of [
    'oat-secret',
    'acct-secret',
    'dotenv-secret',
    'ghp-secret',
    'ops-secret',
    'helper-secret',
  ]) {
    expect(text).not.toInclude(secret);
  }

  expect(JSON.parse(Buffer.from(settings).toString())).toStrictEqual({
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    permissions: { defaultMode: 'auto' },
  });
});

test('it copies a symlinked skill and leaves out a skills folder without a SKILL.md', () => {
  using tmp = setupTempDir('atc-claude-bundle-');

  const host = join(tmp.dir, '.claude');
  const shared = join(tmp.dir, 'shared-skills', 'gh-stack');

  mkdirSync(join(host, 'skills', 'synced', 'abc', 'docx'), { recursive: true });
  mkdirSync(join(shared, 'references'), { recursive: true });
  writeFileSync(join(shared, 'SKILL.md'), 'stack');
  writeFileSync(join(shared, 'references', 'commands.md'), 'commands');
  writeFileSync(join(host, 'skills', 'synced', 'abc', 'docx', 'SKILL.md'), 'docx');
  symlinkSync(shared, join(host, 'skills', 'gh-stack'));
  symlinkSync(join(tmp.dir, 'missing'), join(host, 'skills', 'dangling'));

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config');

  expect(Object.keys(bundle).toSorted()).toStrictEqual([
    'settings.json',
    'skills/gh-stack/SKILL.md',
    'skills/gh-stack/references/commands.md',
  ]);

  const skill = bundle['skills/gh-stack/SKILL.md'];

  if (skill === undefined) {
    throw new Error('expected the symlinked skill in the bundle');
  }

  expect(Buffer.from(skill).toString()).toBe('stack');
});

test('it ends a symlink that loops back up a skill folder', () => {
  using tmp = setupTempDir('atc-claude-bundle-');

  const host = join(tmp.dir, '.claude');
  const skill = join(host, 'skills', 'looped');

  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'looped');
  symlinkSync(skill, join(skill, 'again'));

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config');

  expect(Object.keys(bundle).toSorted()).toStrictEqual(['settings.json', 'skills/looped/SKILL.md']);
});

test('it ships auto mode alone when the host has no Claude config folder', () => {
  using tmp = setupTempDir('atc-claude-bundle-');

  const bundle = loadClaudeConfigBundle(join(tmp.dir, 'missing'), '/guest/claude-config');

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2),
  });
});
