import { expect, test } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateClaudeProjectTrust } from './update-claude-project-trust';

function setupTest() {
  return setupTempDir('atc-claude-trust-');
}

test('it trusts the exact root and keeps every other key of the config', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        numStartups: 12,
        oauthAccount: { accountUuid: 'account' },
        projects: {
          '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
          '/home/me/other': { hasTrustDialogAccepted: false },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  await updateClaudeProjectTrust(configPath, '/work/clones/geo-115');

  expect(readFileSync(configPath, 'utf8')).toBe(
    JSON.stringify(
      {
        numStartups: 12,
        oauthAccount: { accountUuid: 'account' },
        projects: {
          '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
          '/home/me/other': { hasTrustDialogAccepted: false },
          '/work/clones/geo-115': { hasTrustDialogAccepted: true },
        },
      },
      null,
      2,
    ),
  );
});

test('it leaves a sibling folder of the root untrusted', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  writeFileSync(configPath, JSON.stringify({ projects: {} }, null, 2));

  await updateClaudeProjectTrust(configPath, '/work/clones/geo-115');

  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  expect(config).toStrictEqual({
    projects: { '/work/clones/geo-115': { hasTrustDialogAccepted: true } },
  });
});

test('it keeps the fields of an untrusted entry it trusts', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  writeFileSync(
    configPath,
    JSON.stringify(
      { projects: { '/work/clone': { hasTrustDialogAccepted: false, lastCost: 2 } } },
      null,
      2,
    ),
  );

  await updateClaudeProjectTrust(configPath, '/work/clone');

  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  expect(config).toStrictEqual({
    projects: { '/work/clone': { hasTrustDialogAccepted: true, lastCost: 2 } },
  });
});

test('it leaves the config untouched when the root is already trusted', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');
  const original = '{"projects":{"/work/clone":{"hasTrustDialogAccepted":true}}}';

  writeFileSync(configPath, original);

  const before = statSync(configPath);

  const remove = await updateClaudeProjectTrust(configPath, '/work/clone');

  await remove();

  expect(readFileSync(configPath, 'utf8')).toBe(original);
  expect(statSync(configPath).ino).toBe(before.ino);
});

test('it keeps the mode of the config it replaces', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  writeFileSync(configPath, '{}', { mode: 0o600 });

  await updateClaudeProjectTrust(configPath, '/work/clone');

  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(readdirSync(tmp.dir)).toStrictEqual(['.claude.json']);
});

test('it replaces the file a symlinked config points at and keeps the link', async () => {
  await using tmp = setupTest();

  const target = join(tmp.dir, 'dotfiles.json');
  const configPath = join(tmp.dir, '.claude.json');

  writeFileSync(target, '{}');
  symlinkSync(target, configPath);

  await updateClaudeProjectTrust(configPath, '/work/clone');

  const config: unknown = JSON.parse(readFileSync(target, 'utf8'));

  expect(config).toStrictEqual({ projects: { '/work/clone': { hasTrustDialogAccepted: true } } });
  expect(readdirSync(tmp.dir).toSorted()).toStrictEqual(['.claude.json', 'dotfiles.json']);
});

test('it puts back the config as it was when the trust is taken back', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  const original = JSON.stringify(
    { numStartups: 3, projects: { '/home/me': { hasTrustDialogAccepted: true } } },
    null,
    2,
  );

  writeFileSync(configPath, original);

  const remove = await updateClaudeProjectTrust(configPath, '/work/clone');

  await remove();

  expect(readFileSync(configPath, 'utf8')).toBe(original);
});

test('it puts back an untrusted entry when the trust is taken back', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  const original = JSON.stringify(
    { projects: { '/work/clone': { hasTrustDialogAccepted: false, lastCost: 2 } } },
    null,
    2,
  );

  writeFileSync(configPath, original);

  const remove = await updateClaudeProjectTrust(configPath, '/work/clone');

  await remove();

  expect(readFileSync(configPath, 'utf8')).toBe(original);
});

test('it keeps an entry that changed after the trust when the trust is taken back', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  writeFileSync(configPath, '{}');

  const remove = await updateClaudeProjectTrust(configPath, '/work/clone');

  const changed = JSON.stringify(
    { projects: { '/work/clone': { hasTrustDialogAccepted: true, lastCost: 1 } } },
    null,
    2,
  );

  writeFileSync(configPath, changed);

  await remove();

  expect(readFileSync(configPath, 'utf8')).toBe(changed);
});

test('it creates the config when none exists', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  await updateClaudeProjectTrust(configPath, '/work/clone');

  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  expect(config).toStrictEqual({ projects: { '/work/clone': { hasTrustDialogAccepted: true } } });
});

test('it refuses to replace a config that does not parse', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');

  writeFileSync(configPath, '{"projects":');

  expect(updateClaudeProjectTrust(configPath, '/work/clone')).rejects.toThrow(SyntaxError);

  await updateClaudeProjectTrust(configPath, '/work/clone').catch(() => null);

  expect(readFileSync(configPath, 'utf8')).toBe('{"projects":');
  expect(readdirSync(tmp.dir)).toStrictEqual(['.claude.json']);
});

test('it writes only after the Claude CLI releases its config lock', async () => {
  await using tmp = setupTest();

  const configPath = join(tmp.dir, '.claude.json');
  const lockPath = `${configPath}.lock`;

  writeFileSync(configPath, '{}');
  mkdirSync(lockPath);

  const update = updateClaudeProjectTrust(configPath, '/work/clone');

  // Holds the lock long enough for the update to retry against it.
  await Bun.sleep(200);

  const held = readFileSync(configPath, 'utf8');

  rmdirSync(lockPath);

  await update;

  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  expect(held).toBe('{}');
  expect(config).toStrictEqual({ projects: { '/work/clone': { hasTrustDialogAccepted: true } } });
  expect(readdirSync(tmp.dir)).toStrictEqual(['.claude.json']);
});
