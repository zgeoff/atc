import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, runShellcheck } from '@atc/test-utils';
import { $ } from 'bun';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { runLocalCommand } from '../testing/run-local-command';
import { GUEST_CLONE_SCRIPT, createGuestClone } from './create-guest-clone';

// A bare upstream holding one pushed commit, and the empty directory a
// clone lands in, on this machine standing in for the host.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-guest-clone-' });

  const directory = join(fixture.directory, 'ws');

  mkdirSync(directory);

  return {
    directory,
    env: fixture.env,
    upstream: fixture.upstream,
    sha: fixture.sha,
    provider: buildStubMemoryProvider({ kind: 'local-pty', runCommand: runLocalCommand }),
  };
}

test('it checks out the pinned commit detached when no branch is given', async () => {
  const ctx = await setupTest();

  const clone = await createGuestClone(ctx.provider, {
    host: 'h',
    directory: ctx.directory,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: null,
    transports: ['file'],
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.directory).text();
  const branch = await $`git rev-parse --abbrev-ref HEAD`.env(ctx.env).cwd(ctx.directory).text();

  expect(clone).toStrictEqual({ ok: true });
  expect(head.trim()).toBe(ctx.sha);
  expect(branch.trim()).toBe('HEAD');
});

test('it empties the directory and returns the reason when the clone fails', async () => {
  const ctx = await setupTest();

  const clone = await createGuestClone(ctx.provider, {
    host: 'h',
    directory: ctx.directory,
    url: ctx.upstream,
    sha: ctx.sha,
    branch: 'main',
    transports: ['https'],
  });

  expect(clone).toMatchObject({ ok: false, reason: "fatal: transport 'file' not allowed" });
  expect(readdirSync(ctx.directory)).toStrictEqual([]);
});

test('it empties the directory and returns the reason when the pinned commit is not upstream', async () => {
  const ctx = await setupTest();

  const clone = await createGuestClone(ctx.provider, {
    host: 'h',
    directory: ctx.directory,
    url: ctx.upstream,
    sha: '0123456789abcdef0123456789abcdef01234567',
    branch: null,
    transports: ['file'],
  });

  expect(clone).toMatchObject({ ok: false });
  expect(readdirSync(ctx.directory)).toStrictEqual([]);
});

test('it clones through a script that passes shellcheck', async () => {
  const result = await runShellcheck(GUEST_CLONE_SCRIPT);

  expect(result).toStrictEqual({ exitCode: 0, findings: [] });
});
