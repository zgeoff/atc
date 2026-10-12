import { expect, test } from 'bun:test';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { resolveRemoteRef } from './resolve-remote-ref';

// A bare upstream holding one pushed commit on `main`.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-remote-ref-' });

  return { upstream: fixture.upstream, sha: fixture.sha };
}

test('it pins a branch to the commit it points at, on that branch', async () => {
  const ctx = await setupTest();

  const resolved = await resolveRemoteRef(
    { source: { kind: 'git', url: ctx.upstream, ref: 'main' }, transports: ['file'] },
    {},
    [],
  );

  expect(resolved).toStrictEqual({ ok: true, sha: ctx.sha, branch: 'main' });
});

test('it keeps a full commit id detached without asking the upstream', async () => {
  const resolved = await resolveRemoteRef(
    {
      source: { kind: 'git', url: '/nowhere', ref: '0123456789abcdef0123456789abcdef01234567' },
      transports: ['file'],
    },
    {},
    [],
  );

  expect(resolved).toStrictEqual({
    ok: true,
    sha: '0123456789abcdef0123456789abcdef01234567',
    branch: null,
  });
});

test('it refuses a ref the upstream does not have as ref_not_found', async () => {
  const ctx = await setupTest();

  const resolved = await resolveRemoteRef(
    { source: { kind: 'git', url: ctx.upstream, ref: 'missing' }, transports: ['file'] },
    {},
    [],
  );

  expect(resolved).toStrictEqual({
    ok: false,
    code: 'ref_not_found',
    message: "origin has no branch or tag 'missing'",
  });
});

test('it refuses an upstream git cannot list as clone_failed', async () => {
  const ctx = await setupTest();

  const resolved = await resolveRemoteRef(
    { source: { kind: 'git', url: ctx.upstream, ref: 'main' }, transports: ['https'] },
    {},
    [],
  );

  expect(resolved).toMatchObject({ ok: false, code: 'clone_failed' });
});
