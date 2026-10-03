import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { startGitHTTPServer } from '../../test/start-git-http-server';
import { checkRepositoryAccess } from './check-repository-access';

// A bare upstream with one commit on main, a work clone that pushes to it,
// and the upstream served over smart HTTP behind basic auth. Fixture git
// commands read neither the host's system nor its global git config.
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-repo-access-test-'));

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'atc',
    GIT_AUTHOR_EMAIL: 'atc@example.com',
    GIT_COMMITTER_NAME: 'atc',
    GIT_COMMITTER_EMAIL: 'atc@example.com',
  };

  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  await writeFile(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet --no-gpg-sign -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const server = startGitHTTPServer(dir, env);

  return {
    dir,
    env,
    upstream,
    work,
    httpURL: `${server.url}upstream.git`,
    authorizations: server.authorizations,
    async [Symbol.asyncDispose]() {
      await server.stop();

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it resolves a branch to the commit it points at and lists the upstream refs', async () => {
  await using project = await setupTest();

  const sha = await $`git rev-parse HEAD`
    .env(project.env)
    .cwd(project.work)
    .text()
    .then((text) => text.trim());

  const access = await checkRepositoryAccess({ url: project.upstream, ref: 'main' });

  expect(access).toStrictEqual({
    ok: true,
    url: project.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha }],
    resolved: { sha, branch: 'main' },
  });
});

test('it resolves an annotated tag to the commit it points at', async () => {
  await using project = await setupTest();

  await $`git tag --no-sign -a v1 -m release`.env(project.env).cwd(project.work).quiet();
  await $`git push --quiet origin v1`.env(project.env).cwd(project.work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(project.env)
    .cwd(project.work)
    .text()
    .then((text) => text.trim());

  const access = await checkRepositoryAccess({ url: project.upstream, ref: 'v1' });

  expect(access).toMatchObject({ ok: true, resolved: { sha, branch: null } });
});

test('it answers a probe without a ref with the refs alone', async () => {
  await using project = await setupTest();

  const access = await checkRepositoryAccess({ url: project.upstream });

  expect(access).toMatchObject({ ok: true, head: 'main', resolved: null });
});

test('it takes a full commit id as it is', async () => {
  await using project = await setupTest();

  const sha = 'f'.repeat(40);

  const access = await checkRepositoryAccess({ url: project.upstream, sha });

  expect(access).toMatchObject({ ok: true, resolved: { sha, branch: null } });
});

test('it refuses a ref the upstream does not have', async () => {
  await using project = await setupTest();

  const access = await checkRepositoryAccess({ url: project.upstream, ref: 'nope' });

  expect(access).toStrictEqual({
    ok: false,
    code: 'ref_not_found',
    message: "origin has no branch or tag 'nope'",
  });
});

test('it refuses a URL that does not read as a repository URL', async () => {
  const access = await checkRepositoryAccess({ url: 'not a url' });

  expect(access).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: 'not a git repository URL',
  });
});

test('it refuses a URL that carries a credential', async () => {
  const access = await checkRepositoryAccess({ url: 'https://x:tok@example.com/o/r.git' });

  expect(access).toMatchObject({ ok: false, code: 'credential_in_url' });
});

test("it refuses an upstream that asks for a sign-in the host cannot give, with git's own message", async () => {
  await using project = await setupTest();

  const access = await checkRepositoryAccess({ url: project.httpURL });

  expect(access).toMatchObject({
    ok: false,
    code: 'clone_failed',
    message: expect.toInclude('could not read Username'),
  });
});

test('it authenticates through a credential helper in the host git config', async () => {
  await using project = await setupTest();

  await writeFile(
    join(project.dir, 'gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=host-tok; }; f"\n',
  );

  process.env['GIT_CONFIG_GLOBAL'] = join(project.dir, 'gitconfig');

  onTestFinished(() => {
    delete process.env['GIT_CONFIG_GLOBAL'];
  });

  const access = await checkRepositoryAccess({ url: project.httpURL, ref: 'main' });

  expect(access).toMatchObject({ ok: true, resolved: { branch: 'main' } });
  expect(project.authorizations).not.toBeEmpty();

  expect(project.authorizations).toSatisfyAll(
    (header: string) => header === `Basic ${Buffer.from('atc:host-tok').toString('base64')}`,
  );
});

test('it authenticates with an env credential through the askpass helper', async () => {
  await using project = await setupTest();

  process.env['ATC_TEST_PROBE_TOKEN'] = 'tok-77a1';

  onTestFinished(() => {
    delete process.env['ATC_TEST_PROBE_TOKEN'];
  });

  const access = await checkRepositoryAccess({
    url: project.httpURL,
    ref: 'main',
    credential: { kind: 'env', name: 'ATC_TEST_PROBE_TOKEN' },
  });

  expect(access).toMatchObject({ ok: true, resolved: { branch: 'main' } });
  expect(project.authorizations).not.toBeEmpty();

  expect(project.authorizations).toSatisfyAll(
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

  const marker = `silent-${crypto.randomUUID()}`;
  const started = Date.now();

  const access = await checkRepositoryAccess({
    url: `http://127.0.0.1:${server.port}/${marker}.git`,
    timeoutMs: 300,
  });

  // A killed process group is gone once the kernel reaps it, which takes a
  // moment after the signal.
  await Bun.sleep(300);

  const left = Bun.spawnSync(['pgrep', '-f', marker]).stdout.toString();

  expect(access).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: 'git ls-remote did not answer within 0.3 s',
  });

  expect(Date.now() - started).toBeLessThan(5000);
  expect(left).toBe('');
});
