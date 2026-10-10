import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { readHostGitIdentity } from './read-host-git-identity';

function setupTest() {
  const tmp = setupTempDir('atc-host-identity-');
  const config = join(tmp.dir, 'gitconfig');

  updateEnv('GIT_CONFIG_GLOBAL', config);
  updateEnv('GIT_CONFIG_NOSYSTEM', '1');

  return { config };
}

test('it reads the name and email from the global git config', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.config, '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');

  const identity = await readHostGitIdentity();

  expect(identity).toStrictEqual({
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  });
});

test('it resolves to null when the global git config holds no email', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.config, '[user]\n\tname = Ada Lovelace\n');

  const identity = await readHostGitIdentity();

  expect(identity).toBeNull();
});

test('it resolves to null when the global git config holds no name', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.config, '[user]\n\temail = ada@example.com\n');

  const identity = await readHostGitIdentity();

  expect(identity).toBeNull();
});

test('it ignores the identity of the repository the daemon runs in', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.config, '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');

  const repo = setupTempDir('atc-host-identity-repo-');
  const gitDir = join(repo.dir, '.git');

  mkdirSync(join(gitDir, 'objects'), { recursive: true });
  mkdirSync(join(gitDir, 'refs'));
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

  writeFileSync(
    join(gitDir, 'config'),
    '[user]\n\tname = Local Person\n\temail = local@example.com\n',
  );

  const previous = process.cwd();

  process.chdir(repo.dir);

  onTestFinished(() => process.chdir(previous));

  const identity = await readHostGitIdentity();

  expect(identity).toStrictEqual({
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  });
});
