import { expect, onTestFinished, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { DEFAULT_GIT_TRANSPORTS } from '../shared/default-git-transports';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { startGitHTTPServer } from '../test-utils/start-git-http-server';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { checkRepositoryAccess } from './check-repository-access';

// The fixture upstream served over smart HTTP behind basic auth.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const fixture = await createGitFixture({ prefix: 'atc-repo-access-test-' });

  stack.use(fixture);

  const server = startGitHTTPServer(fixture.dir, fixture.env);

  stack.defer(() => server.stop());

  const owned = stack.move();

  return {
    dir: fixture.dir,
    env: fixture.env,
    upstream: fixture.upstream,
    work: fixture.work,
    sha: fixture.sha,
    httpURL: `${server.url}upstream.git`,
    authorizations: server.authorizations,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it resolves a branch to the commit it points at and lists the upstream refs', async () => {
  await using ctx = await setupTest();

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.upstream,
    ref: 'main',
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: ctx.sha }],
    resolved: { sha: ctx.sha, branch: 'main' },
  });
});

test('it resolves an annotated tag to the commit it points at', async () => {
  await using ctx = await setupTest();

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
      { name: 'main', kind: 'branch', sha: ctx.sha },
      { name: 'v1', kind: 'tag', sha: ctx.sha },
    ],
    resolved: { sha: ctx.sha, branch: null },
  });
});

test('it answers a probe without a ref with the refs alone', async () => {
  await using ctx = await setupTest();

  const access = await checkRepositoryAccess({
    transports: ['https', 'ssh', 'http', 'file'],
    url: ctx.upstream,
  });

  expect(access).toStrictEqual({
    ok: true,
    url: ctx.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: ctx.sha }],
    resolved: null,
  });
});

test('it takes a full commit id as it is', async () => {
  await using ctx = await setupTest();

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
    refs: [{ name: 'main', kind: 'branch', sha: ctx.sha }],
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
    refs: [{ name: 'main', kind: 'branch', sha: ctx.sha }],
    resolved: { sha: ctx.sha, branch: 'main' },
  });

  expect(ctx.authorizations).not.toBeEmpty();

  expect(ctx.authorizations).toSatisfyAll(
    (header: string) => header === `Basic ${Buffer.from('atc:host-tok').toString('base64')}`,
  );
});

test('it authenticates with an env credential through the askpass helper', async () => {
  await using ctx = await setupTest();

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
    refs: [{ name: 'main', kind: 'branch', sha: ctx.sha }],
    resolved: { sha: ctx.sha, branch: 'main' },
  });

  expect(ctx.authorizations).not.toBeEmpty();

  expect(ctx.authorizations).toSatisfyAll(
    (header: string) =>
      header === `Basic ${Buffer.from('x-access-token:tok-77a1').toString('base64')}`,
  );
});

test('it refuses an upstream that does not answer within its time limit and leaves no git process behind', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Promise<Response>(() => {}),
  });

  onTestFinished(async () => {
    await server.stop(true);
  });

  const access = await checkRepositoryAccess({
    url: `http://127.0.0.1:${server.port}/silent.git`,
    timeoutMs: 300,
    transports: ['https', 'ssh', 'http', 'file'],
  });

  expect(access).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: 'git ls-remote did not answer within 0.3 s',
  });

  // A killed process group is gone once the kernel reaps it, a moment after
  // the signal. The server's own port keeps the match to this test's git.
  await waitFor(() => {
    expect(Bun.spawnSync(['pgrep', '-f', `127.0.0.1:${server.port}/`]).stdout.toString()).toBe('');
  });
});

test.each([
  [
    'a file URL',
    'file:///srv/git/app.git',
    "git transport 'file' is not allowed; the daemon fetches over https and ssh",
  ],
  [
    'an ext helper that runs a command',
    'ext::sh -c touch% /tmp/atc-ext',
    'not a git repository URL',
  ],
  [
    'an fd helper',
    'fd::17',
    "git transport 'fd' is not allowed; the daemon fetches over https and ssh",
  ],
  [
    'a local path',
    '/srv/git/app.git',
    "git transport 'file' is not allowed; the daemon fetches over https and ssh",
  ],
  [
    'a URL that reads as an option',
    '-uhttps://example.com/app.git',
    'a git URL must not start with -',
  ],
])('it refuses %s before any git runs', async (_, url, message) => {
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
