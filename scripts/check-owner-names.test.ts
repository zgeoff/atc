import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createGitFixture, runCommand } from '@atc/test-utils';

// A git work clone standing in for a repo root, beside a hashes file outside
// it. Every git and check run takes the fixture's env, which drops the GIT_
// variables a pre-push hook exports, so no run reaches the repo running it.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'check-owner-names-' });

  return {
    repo: fixture.work,
    env: fixture.env,
    hashesFile: join(fixture.dir, 'hashes.json'),
  };
}

test('it passes a repo that uses only invented names', async () => {
  const ctx = await setupTest();

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

  await runCommand(['git', 'add', '.'], { cwd: ctx.repo, env: ctx.env });

  const checked = await runCommand(
    [process.execPath, join(import.meta.dir, 'check-owner-names.ts'), ctx.repo, ctx.hashesFile],
    { env: ctx.env },
  );

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
  const ctx = await setupTest();

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

  await runCommand(['git', 'add', 'packages', 'docs'], { cwd: ctx.repo, env: ctx.env });

  const checked = await runCommand(
    [process.execPath, join(import.meta.dir, 'check-owner-names.ts'), ctx.repo, ctx.hashesFile],
    { env: ctx.env },
  );

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

test.each([
  ['a subdomain of the owner domain', 'https://deep.atc.owner.example:8443/mcp', 'owner domain'],
  ['the owner domain in capitals', 'Host: OWNER.EXAMPLE', 'owner domain'],
  ['the owner domain with a trailing dot', 'dig owner.example.', 'owner domain'],
  ['the owner domain in an email', 'mail pat@owner.example', 'owner domain'],
  ['a macOS home path', 'cd /Users/pat/projects', 'owner home path'],
  ['a home path that ends a sentence', 'It sits in /home/pat.', 'owner home path'],
  ['a home path before a comma', 'Use /home/pat, then stop.', 'owner home path'],
  ['a home path in capitals', 'cd /Users/Pat/notes', 'owner home path'],
  [
    'a vault outside the allow list',
    'op read op://team-vault/item/token',
    'vault outside the allow list',
  ],
  ['an allowed vault in capitals', 'op read op://Vault/item/token', 'vault outside the allow list'],
  [
    'a vault that only starts with an allowed name',
    'op read op://vaults/item',
    'vault outside the allow list',
  ],
  [
    'a vault that extends an allowed name',
    'op read op://example-real/item',
    'vault outside the allow list',
  ],
  ['an empty vault name', 'op read op:///item/token', 'vault outside the allow list'],
])('it refuses %s in a tracked file', async (_label, line, kind) => {
  const ctx = await setupTest();

  await Bun.write(
    ctx.hashesFile,
    JSON.stringify({
      domains: [new Bun.CryptoHasher('sha256').update('owner.example').digest('hex')],
      logins: [new Bun.CryptoHasher('sha256').update('pat').digest('hex')],
    }),
  );

  await Bun.write(join(ctx.repo, 'docs/a.md'), `${line}\n`);

  await runCommand(['git', 'add', '.'], { cwd: ctx.repo, env: ctx.env });

  const checked = await runCommand(
    [process.execPath, join(import.meta.dir, 'check-owner-names.ts'), ctx.repo, ctx.hashesFile],
    { env: ctx.env },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-owner-names: 1 owner names\n',
    stderr: `${kind}: docs/a.md:1\n`,
  });
});

test.each([
  ['a domain that only ends with the owner domain text', 'https://notowner.example'],
  ['a domain that extends the owner domain', 'https://owner.example.org'],
  ['a domain with a hyphen in place of the dot', 'https://owner-example.com'],
  ['a login that only starts with the owner login', 'cd /home/patrick/projects'],
  ['an allowed vault', 'op read op://vault/item/token'],
  ['a vault placeholder', 'op read op://$VAULT/item/token'],
])('it passes %s in a tracked file', async (_label, line) => {
  const ctx = await setupTest();

  await Bun.write(
    ctx.hashesFile,
    JSON.stringify({
      domains: [new Bun.CryptoHasher('sha256').update('owner.example').digest('hex')],
      logins: [new Bun.CryptoHasher('sha256').update('pat').digest('hex')],
    }),
  );

  await Bun.write(join(ctx.repo, 'docs/a.md'), `${line}\n`);

  await runCommand(['git', 'add', '.'], { cwd: ctx.repo, env: ctx.env });

  const checked = await runCommand(
    [process.execPath, join(import.meta.dir, 'check-owner-names.ts'), ctx.repo, ctx.hashesFile],
    { env: ctx.env },
  );

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
