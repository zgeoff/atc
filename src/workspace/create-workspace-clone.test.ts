import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { createWorkspaceClone } from './create-workspace-clone';

async function setupTest() {
  // A git hook exports GIT_DIR and friends, which would point these
  // commands at the repository running the hook instead of the temp tree.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );

  const dir = await mkdtemp(join(tmpdir(), 'atc-clone-'));

  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');
  const authorizations: string[] = [];
  const childArgv: string[] = [];
  const askpassHelpers: string[] = [];

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();
  await $`git config tag.gpgsign false`.env(env).cwd(work).quiet();

  await writeFile(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  // Smart HTTP in front of the upstream through `git http-backend`, refusing
  // any request without basic auth. While a request is held, the argv and
  // askpass helper of every process descended from this test run are
  // recorded from /proc.
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const authorization = request.headers.get('authorization');

      if (authorization === null) {
        return new Response('auth required', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="atc"' },
        });
      }

      authorizations.push(authorization);

      const entries = process.platform === 'linux' ? await readdir('/proc') : [];

      const parents = new Map<string, string>();

      for (const pid of entries.filter((entry) => /^\d+$/u.test(entry))) {
        const stat = await readFile(join('/proc', pid, 'stat'), 'utf8').catch(() => '');

        parents.set(pid, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? '');
      }

      for (const pid of parents.keys()) {
        let ancestor = parents.get(pid);

        while (ancestor !== undefined && ancestor !== String(process.pid)) {
          ancestor = parents.get(ancestor);
        }

        if (ancestor === undefined) {
          continue;
        }

        const cmdline = await readFile(join('/proc', pid, 'cmdline'), 'utf8').catch(() => '');
        const environ = await readFile(join('/proc', pid, 'environ'), 'utf8').catch(() => '');

        childArgv.push(cmdline.replaceAll('\0', ' '));

        askpassHelpers.push(
          ...environ
            .split('\0')
            .filter((entry) => entry.startsWith('GIT_ASKPASS='))
            .map((entry) => entry.slice('GIT_ASKPASS='.length)),
        );
      }

      const url = new URL(request.url);

      const body = await request.arrayBuffer();

      const backend = Bun.spawn(['git', 'http-backend'], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: dir,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get('content-type') ?? '',
          HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
          HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
          REMOTE_USER: 'atc',
          REMOTE_ADDR: '127.0.0.1',
        },
        stdin: new Uint8Array(body),
        stdout: 'pipe',
        stderr: 'ignore',
      });

      const raw = await new Response(backend.stdout).arrayBuffer();

      const output = Buffer.from(raw);
      const split = output.indexOf('\r\n\r\n');

      const headers = new Headers();

      let status = 200;

      for (const line of output.subarray(0, split).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();

        if (name.toLowerCase() === 'status') {
          status = Number(value.split(' ')[0]);
        } else {
          headers.append(name, value);
        }
      }

      return new Response(output.subarray(split + 4), { status, headers });
    },
  });

  return {
    env,
    dir,
    upstream,
    work,
    httpURL: `http://127.0.0.1:${server.port}/upstream.git`,
    authorizations,
    childArgv,
    askpassHelpers,
    async [Symbol.asyncDispose]() {
      await server.stop(true);

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it checks out the commit a branch points at, on that branch', async () => {
  await using project = await setupTest();

  const upstreamHead = await $`git rev-parse main`.env(project.env).cwd(project.upstream).text();

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: 'main' },
    dir: join(project.dir, 'clone'),
  });

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(join(project.dir, 'clone')).text();

  const branch = await $`git symbolic-ref --short HEAD`
    .env(project.env)
    .cwd(join(project.dir, 'clone'))
    .text();

  expect(clone).toStrictEqual({ ok: true, sha: upstreamHead.trim(), branch: 'main' });
  expect(head.trim()).toBe(upstreamHead.trim());
  expect(branch.trim()).toBe('main');
});

test('it checks out the commit an annotated tag points at, detached', async () => {
  await using project = await setupTest();

  const tagged = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await $`git tag -a v1 -m v1`.env(project.env).cwd(project.work).quiet();

  await writeFile(join(project.work, 'README.md'), 'after the tag\n');

  await $`git commit --quiet -am later`.env(project.env).cwd(project.work).quiet();
  await $`git push --quiet origin main v1`.env(project.env).cwd(project.work).quiet();

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: 'v1' },
    dir: join(project.dir, 'clone'),
  });

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(join(project.dir, 'clone')).text();

  expect(clone).toStrictEqual({ ok: true, sha: tagged.trim(), branch: null });
  expect(head.trim()).toBe(tagged.trim());
});

test('it checks out a full commit id detached', async () => {
  await using project = await setupTest();

  const pinned = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await writeFile(join(project.work, 'README.md'), 'later\n');

  await $`git commit --quiet -am later`.env(project.env).cwd(project.work).quiet();
  await $`git push --quiet origin main`.env(project.env).cwd(project.work).quiet();

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: pinned.trim() },
    dir: join(project.dir, 'clone'),
  });

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(join(project.dir, 'clone')).text();

  expect(clone).toStrictEqual({ ok: true, sha: pinned.trim(), branch: null });
  expect(head.trim()).toBe(pinned.trim());
});

test('it copies objects instead of hard-linking them from a local upstream', async () => {
  await using project = await setupTest();

  await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: 'main' },
    dir: join(project.dir, 'clone'),
  });

  const linked = await $`find ${join(project.dir, 'clone', '.git', 'objects')} -type f -links +1`
    .env(project.env)
    .text();

  const alternates = join(project.dir, 'clone', '.git', 'objects', 'info', 'alternates');

  expect(linked).toBe('');
  expect(existsSync(alternates)).toBeFalse();
});

test('it refuses a ref the upstream does not have', async () => {
  await using project = await setupTest();

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: 'missing' },
    dir: join(project.dir, 'clone'),
  });

  expect(clone).toMatchObject({ ok: false, code: 'ref_not_found' });
});

test('it refuses an upstream it cannot reach', async () => {
  await using project = await setupTest();

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: join(project.dir, 'missing.git'), ref: 'main' },
    dir: join(project.dir, 'clone'),
  });

  expect(clone).toMatchObject({ ok: false, code: 'clone_failed' });
});

test('it refuses an env credential whose variable is unset', async () => {
  await using project = await setupTest();

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.httpURL, ref: 'main' },
    dir: join(project.dir, 'clone'),
    credential: { kind: 'env', name: 'ATC_TEST_UNSET_GIT_TOKEN' },
  });

  expect(clone).toMatchObject({ ok: false, code: 'credential_missing' });
});

// The argv and helper checks read /proc, which only Linux has.
test.skipIf(process.platform !== 'linux')(
  'it authenticates with an env credential that never reaches argv or outlives the clone',
  async () => {
    await using project = await setupTest();

    process.env['ATC_TEST_GIT_TOKEN'] = 'tok-4f9c2e';

    onTestFinished(() => {
      delete process.env['ATC_TEST_GIT_TOKEN'];
    });

    const clone = await createWorkspaceClone({
      source: { kind: 'git', url: project.httpURL, ref: 'main' },
      dir: join(project.dir, 'clone'),
      credential: { kind: 'env', name: 'ATC_TEST_GIT_TOKEN' },
    });

    const config = await readFile(join(project.dir, 'clone', '.git', 'config'), 'utf8');

    expect(clone).toMatchObject({ ok: true, branch: 'main' });
    expect(project.authorizations).not.toBeEmpty();

    expect(project.authorizations).toSatisfyAll(
      (header: string) =>
        header === `Basic ${Buffer.from('x-access-token:tok-4f9c2e').toString('base64')}`,
    );

    expect(project.childArgv).not.toBeEmpty();

    expect(project.childArgv).toSatisfyAll(
      (argv: string) => !argv.includes('tok-4f9c2e') && !argv.includes('ATC_TEST_GIT_TOKEN'),
    );

    expect(project.askpassHelpers).not.toBeEmpty();
    expect(project.askpassHelpers.filter((helper) => existsSync(helper))).toStrictEqual([]);
    expect(config).not.toInclude('tok-4f9c2e');
  },
);

test('it refuses a git source whose commit holds a gitlink and leaves no directory', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  await $`git update-index --add --cacheinfo ${`160000,${head.trim()},vendored`}`
    .env(project.env)
    .cwd(project.work)
    .quiet();

  await $`git commit --quiet -m gitlink`.env(project.env).cwd(project.work).quiet();
  await $`git push --quiet origin main`.env(project.env).cwd(project.work).quiet();

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: 'main' },
    dir: join(project.dir, 'clone'),
  });

  expect(clone).toMatchObject({ ok: false, code: 'has_submodules' });
  expect(existsSync(join(project.dir, 'clone'))).toBeFalse();
});

test('it refuses a git source that tracks LFS paths without running the host LFS filter', async () => {
  await using project = await setupTest();

  await writeFile(
    join(project.work, '.gitattributes'),
    '*.bin filter=lfs diff=lfs merge=lfs -text\n',
  );

  await writeFile(
    join(project.work, 'asset.bin'),
    'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n',
  );

  await $`git add .gitattributes asset.bin`.env(project.env).cwd(project.work).quiet();
  await $`git commit --quiet -m lfs`.env(project.env).cwd(project.work).quiet();
  await $`git push --quiet origin main`.env(project.env).cwd(project.work).quiet();

  const marker = join(project.dir, 'filter-ran');

  await writeFile(join(project.dir, 'trap'), `#!/bin/sh\necho ran >> ${marker}\ncat\n`, {
    mode: 0o755,
  });

  await writeFile(
    join(project.dir, 'gitconfig'),
    `[filter "lfs"]\n\tsmudge = ${join(project.dir, 'trap')}\n\tprocess = ${join(project.dir, 'trap')}\n\trequired = true\n`,
  );

  process.env['GIT_CONFIG_GLOBAL'] = join(project.dir, 'gitconfig');

  onTestFinished(() => {
    delete process.env['GIT_CONFIG_GLOBAL'];
  });

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: 'main' },
    dir: join(project.dir, 'clone'),
  });

  expect(clone).toMatchObject({
    ok: false,
    code: 'lfs_unsupported',
    count: 1,
    paths: ['asset.bin'],
  });

  expect(existsSync(marker)).toBeFalse();
  expect(existsSync(join(project.dir, 'clone'))).toBeFalse();
});

test('it checks out without running a filter from the host global git config', async () => {
  await using project = await setupTest();

  const marker = join(project.dir, 'filter-ran');

  await writeFile(join(project.dir, 'trap'), `#!/bin/sh\necho ran >> ${marker}\ncat\n`, {
    mode: 0o755,
  });

  await writeFile(join(project.dir, 'attributes'), '* filter=trap\n');

  await writeFile(
    join(project.dir, 'gitconfig'),
    `[core]\n\tattributesFile = ${join(project.dir, 'attributes')}\n[filter "trap"]\n\tsmudge = ${join(project.dir, 'trap')}\n`,
  );

  process.env['GIT_CONFIG_GLOBAL'] = join(project.dir, 'gitconfig');

  onTestFinished(() => {
    delete process.env['GIT_CONFIG_GLOBAL'];
  });

  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: project.upstream, ref: 'main' },
    dir: join(project.dir, 'clone'),
  });

  const readme = await readFile(join(project.dir, 'clone', 'README.md'), 'utf8');

  expect(clone).toMatchObject({ ok: true, branch: 'main' });
  expect(existsSync(marker)).toBeFalse();
  expect(readme).toBe('hello\n');
});
