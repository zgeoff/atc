import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { DEFAULT_GIT_TRANSPORTS } from '../shared/default-git-transports';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { startGitHTTPServer } from '../test-utils/start-git-http-server';
import { startStubSilentServer } from '../test-utils/start-stub-silent-server';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { checkRepositoryAccess } from './check-repository-access';

// The fixture upstream served over smart HTTP behind basic auth, and a
// server that holds every request without ever answering it.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const fixture = await createGitFixture({ prefix: 'atc-repo-access-test-' });

  stack.use(fixture);

  const server = startGitHTTPServer(fixture.dir, fixture.env);

  stack.defer(() => server.stop());

  const silent = stack.use(startStubSilentServer());
  const owned = stack.move();

  return {
    dir: fixture.dir,
    env: fixture.env,
    upstream: fixture.upstream,
    work: fixture.work,
    httpURL: `${server.url}upstream.git`,
    authorizations: server.authorizations,
    silentURL: `${silent.url}silent.git`,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it resolves a branch to the commit it points at and lists the upstream refs', async () => {
  await using ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.upstream,
    ref: 'main',
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: pushed }],
    resolved: { sha: pushed, branch: 'main' },
  });
});

test('it resolves an annotated tag to the commit it points at', async () => {
  await using ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await $`git tag --no-sign -a v1 -m release`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin v1`.env(ctx.env).cwd(ctx.work).quiet();

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.upstream,
    ref: 'v1',
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    head: 'main',
    refs: [
      { name: 'main', kind: 'branch', sha: pushed },
      { name: 'v1', kind: 'tag', sha: pushed },
    ],
    resolved: { sha: pushed, branch: null },
  });
});

test('it answers a probe without a ref with the refs alone', async () => {
  await using ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.upstream,
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: pushed }],
    resolved: null,
  });
});

test('it takes a full commit id as it is', async () => {
  await using ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const sha = 'f'.repeat(40);

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.upstream,
    sha,
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: pushed }],
    resolved: { sha, branch: null },
  });
});

test('it refuses a ref the upstream does not have', async () => {
  await using ctx = await setupTest();

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.upstream,
    ref: 'nope',
  });

  expect(access).toStrictEqual({
    ok: false,
    code: 'ref_not_found',
    message: "origin has no branch or tag 'nope'",
  });
});

test('it refuses a URL that does not read as a repository URL', async () => {
  const access = await checkRepositoryAccess({
    url: 'not a url',
    transports: DEFAULT_GIT_TRANSPORTS,
  });

  expect(access).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: 'not a git repository URL',
  });
});

test('it refuses a URL that carries a credential', async () => {
  const access = await checkRepositoryAccess({
    url: 'https://x:tok@example.com/o/r.git',
    transports: DEFAULT_GIT_TRANSPORTS,
  });

  expect(access).toStrictEqual({
    ok: false,
    code: 'credential_in_url',
    message: 'the repository URL carries a credential; pass it as a credentialRef instead',
  });
});

test("it refuses an upstream that asks for a sign-in the host cannot give, with git's own message", async () => {
  await using ctx = await setupTest();

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.httpURL,
  });

  expect(access).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: expect.toInclude('could not read Username'),
  });
});

test('it authenticates through a credential helper in the host git config', async () => {
  await using ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await writeFile(
    join(ctx.dir, 'gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=host-tok; }; f"\n',
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.httpURL,
    ref: 'main',
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.httpURL,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: pushed }],
    resolved: { sha: pushed, branch: 'main' },
  });

  expect(ctx.authorizations).not.toBeEmpty();

  expect(ctx.authorizations).toSatisfyAll(
    (header: string) => header === `Basic ${Buffer.from('atc:host-tok').toString('base64')}`,
  );
});

test('it authenticates with an env credential through the askpass helper', async () => {
  await using ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  updateEnv('ATC_TEST_PROBE_TOKEN', 'tok-77a1');

  const access = await checkRepositoryAccess({
    url: ctx.httpURL,
    transports: ['https', 'ssh', 'http', 'file'],
    ref: 'main',
    credential: { kind: 'env', name: 'ATC_TEST_PROBE_TOKEN' },
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.httpURL,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: pushed }],
    resolved: { sha: pushed, branch: 'main' },
  });

  expect(ctx.authorizations).not.toBeEmpty();

  expect(ctx.authorizations).toSatisfyAll(
    (header: string) =>
      header === `Basic ${Buffer.from('x-access-token:tok-77a1').toString('base64')}`,
  );
});

test('it refuses an upstream that does not answer within its time limit and leaves no git process behind', async () => {
  await using ctx = await setupTest();

  const groups: number[] = [];

  const access = await checkRepositoryAccess({
    url: ctx.silentURL,
    timeoutMs: 300,
    transports: ['https', 'ssh', 'http', 'file'],
    onSpawn: (pid) => {
      groups.push(pid);
    },
  });

  expect(access).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: 'git ls-remote did not answer within 0.3 s',
  });

  expect(groups).toHaveLength(1);

  // The listing's git leads its own process group. A killed group is gone
  // once the kernel reaps it, a moment after the signal.
  await waitFor(() => {
    expect(() => process.kill(-(groups[0] ?? 0), 0)).toThrow('ESRCH');
  });
});

test.each([
  [
    'file:///srv/git/app.git',
    "git transport 'file' is not allowed; the daemon fetches over https and ssh",
  ],
  ['ext::sh -c touch% /tmp/atc-ext', 'not a git repository URL'],
  ['fd::17', "git transport 'fd' is not allowed; the daemon fetches over https and ssh"],
  [
    '/srv/git/app.git',
    "git transport 'file' is not allowed; the daemon fetches over https and ssh",
  ],
  ['-uhttps://example.com/app.git', 'a git URL must not start with -'],
])('it refuses the URL %s before any git runs', async (url, message) => {
  await using ctx = await setupTest();

  // A git first on the PATH records each run, so a refusal that runs git
  // leaves the record behind.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho ran >> '${join(ctx.dir, 'git-ran')}'\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  const access = await checkRepositoryAccess({ url, transports: DEFAULT_GIT_TRANSPORTS });
  const ran = await Bun.file(join(ctx.dir, 'git-ran')).exists();

  expect(access).toStrictEqual({ ok: false, code: 'invalid_git_url', message });
  expect(ran).toBeFalse();
});

test('it refuses an https URL the host git config rewrites to a local repository, in git', async () => {
  await using ctx = await setupTest();

  await writeFile(
    join(ctx.dir, 'gitconfig'),
    `[url "file://${ctx.upstream}"]\n\tinsteadOf = https://example.invalid/upstream.git\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const access = await checkRepositoryAccess({
    url: 'https://example.invalid/upstream.git',
    transports: DEFAULT_GIT_TRANSPORTS,
  });

  expect(access).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: expect.toInclude("transport 'file' not allowed"),
  });
});
