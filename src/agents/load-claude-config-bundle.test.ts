import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateEnv } from '../../test/update-env';
import { resolveHomeDir } from '../shared/resolve-home-dir';
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

  if (!(rules instanceof Uint8Array)) {
    throw new TypeError('expected CLAUDE.md in the bundle');
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
    .map((file) => {
      const content = typeof file === 'string' || file instanceof Uint8Array ? file : file.content;

      return Buffer.from(content).toString();
    })
    .join('\n');

  const settings = bundle['settings.json'];

  if (typeof settings !== 'string') {
    throw new TypeError('expected settings.json in the bundle');
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

  expect(JSON.parse(settings)).toStrictEqual({
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

  if (!(skill instanceof Uint8Array)) {
    throw new TypeError('expected the symlinked skill in the bundle');
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

test('it ships an executable file with an executable mode and any other file as bytes', () => {
  using tmp = setupTempDir('atc-claude-bundle-');

  const host = join(tmp.dir, '.claude');

  mkdirSync(join(host, 'skills', 'tool', 'scripts'), { recursive: true });
  writeFileSync(join(host, 'statusline.sh'), 'echo status');
  writeFileSync(join(host, 'skills', 'tool', 'SKILL.md'), 'tool');
  writeFileSync(join(host, 'skills', 'tool', 'scripts', 'run.sh'), 'echo run');
  chmodSync(join(host, 'statusline.sh'), 0o700);
  chmodSync(join(host, 'skills', 'tool', 'scripts', 'run.sh'), 0o755);

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config');

  expect({
    statusline: bundle['statusline.sh'],
    script: bundle['skills/tool/scripts/run.sh'],
    skill: bundle['skills/tool/SKILL.md'],
  }).toStrictEqual({
    statusline: { content: Buffer.from('echo status'), mode: 0o755 },
    script: { content: Buffer.from('echo run'), mode: 0o755 },
    skill: Buffer.from('tool'),
  });
});

test("it points a home-relative statusline at the guest when the host folder is the home's own", () => {
  using tmp = setupTempDir('atc-claude-bundle-home-');

  updateEnv('HOME', tmp.dir);

  const host = join(resolveHomeDir(), '.claude');

  mkdirSync(host, { recursive: true });

  writeFileSync(
    join(host, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline.sh' } }),
  );

  const bundle = loadClaudeConfigBundle(host, '/guest/claude-config');
  const settings = bundle['settings.json'];

  if (typeof settings !== 'string') {
    throw new TypeError('expected settings.json in the bundle');
  }

  expect(JSON.parse(settings)).toHaveProperty(
    'statusLine.command',
    'bash /guest/claude-config/statusline.sh',
  );
});

test('it ships auto mode alone when the host has no Claude config folder', () => {
  using tmp = setupTempDir('atc-claude-bundle-');

  const bundle = loadClaudeConfigBundle(join(tmp.dir, 'missing'), '/guest/claude-config');

  expect(bundle).toStrictEqual({
    'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2),
  });
});
