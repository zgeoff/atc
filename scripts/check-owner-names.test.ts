import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp git repo standing in for a repo root, beside a hashes file outside it.
function setupTest() {
  const tmp = setupTempDir('check-owner-names-');

  return { repo: join(tmp.dir, 'repo'), hashesFile: join(tmp.dir, 'hashes.json') };
}

test('it passes a repo that uses only invented names', async () => {
  const ctx = setupTest();

  await Bun.write(
    ctx.hashesFile,
    JSON.stringify({
      domains: [new Bun.CryptoHasher('sha256').update('owner.example').digest('hex')],
      logins: [new Bun.CryptoHasher('sha256').update('pat').digest('hex')],
    }),
  );

  await Bun.write(
    join(ctx.repo, 'packages/a.test.ts'),
    [
      "const url = 'https://atc.example.com';",
      "const host = 'notowner.example';",
      "const home = '/home/me/projects';",
      "const helper = 'op read op://vault/zai/key';",
      "const fromEnv = 'op://$VAULT/token';",
      "const doc = 'op://<vault>/item';",
      '',
    ].join('\n'),
  );

  await runCommand(['git', 'init', '-q'], { cwd: ctx.repo });
  await runCommand(['git', 'add', '.'], { cwd: ctx.repo });

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-owner-names.ts'),
    ctx.repo,
    ctx.hashesFile,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-owner-names: 0 owner names\n',
    stderr: '',
  });
});

test('it fails on the owner domain, home path, and vault, and names each line without its text', async () => {
  const ctx = setupTest();

  await Bun.write(
    ctx.hashesFile,
    JSON.stringify({
      domains: [new Bun.CryptoHasher('sha256').update('owner.example').digest('hex')],
      logins: [new Bun.CryptoHasher('sha256').update('pat').digest('hex')],
    }),
  );

  await Bun.write(
    join(ctx.repo, 'packages/a.test.ts'),
    [
      "const url = 'https://atc.owner.example';",
      "const apex = 'OWNER.example';",
      "const home = '/home/pat/projects';",
      '',
    ].join('\n'),
  );

  await Bun.write(join(ctx.repo, 'docs/guide.md'), '- `op read op://team-vault/item/token`\n');

  // an untracked file is not part of the repo
  await Bun.write(join(ctx.repo, 'notes.txt'), '/Users/pat\n');

  await runCommand(['git', 'init', '-q'], { cwd: ctx.repo });
  await runCommand(['git', 'add', 'packages', 'docs'], { cwd: ctx.repo });

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-owner-names.ts'),
    ctx.repo,
    ctx.hashesFile,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-owner-names: 4 owner names\n',
    stderr: [
      'vault outside the allow list: docs/guide.md:1',
      'owner domain: packages/a.test.ts:1',
      'owner domain: packages/a.test.ts:2',
      'owner home path: packages/a.test.ts:3',
      '',
    ].join('\n'),
  });
});
