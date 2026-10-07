import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from './create-git-fixture';
import { startGitHTTPServer } from './start-git-http-server';
import { waitFor } from './wait-for';

// A bare repository with one commit at `upstream.git` under `dir`, for the
// server under test to serve; `env` keeps the host's git config and any
// credential prompt out of every git command.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const created = await createGitFixture({ prefix: 'atc-git-http-' });

  const fixture = stack.use(created);
  const owned = stack.move();

  return {
    dir: fixture.dir,
    env: { ...fixture.env, GIT_TERMINAL_PROMPT: '0' },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it clones a served repository for a client that authenticates and records the header', async () => {
  await using ctx = await setupTest();

  const server = startGitHTTPServer(ctx.dir, ctx.env);

  onTestFinished(() => server.stop());

  const url = new URL('upstream.git', server.url);

  url.username = 'x-access-token';
  url.password = 'fixture-not-a-secret';

  const clone = await $`git clone --quiet ${url.href} ${join(ctx.dir, 'clone')}`
    .env(ctx.env)
    .nothrow()
    .quiet();

  expect(clone.exitCode).toBe(0);
  expect(server.authorizations).not.toBeEmpty();

  expect(server.authorizations).toSatisfyAll(
    (header: string) =>
      header === `Basic ${Buffer.from('x-access-token:fixture-not-a-secret').toString('base64')}`,
  );
});

test('it refuses a client that does not authenticate', async () => {
  await using ctx = await setupTest();

  const server = startGitHTTPServer(ctx.dir, ctx.env);

  onTestFinished(() => server.stop());

  const clone = await $`git clone --quiet ${`${server.url}upstream.git`} ${join(ctx.dir, 'c')}`
    .env(ctx.env)
    .nothrow()
    .quiet();

  expect(clone.exitCode).not.toBe(0);
  expect(server.authorizations).toStrictEqual([]);
});

test('it holds each authenticated request for the delay it is given', async () => {
  await using ctx = await setupTest();

  const release = Promise.withResolvers<void>();
  const waits: number[] = [];

  const server = startGitHTTPServer(ctx.dir, ctx.env, {
    delayMs: 400,
    wait: (ms) => {
      waits.push(ms);

      return release.promise;
    },
  });

  onTestFinished(() => server.stop());

  const url = new URL('upstream.git', server.url);

  url.username = 'x-access-token';
  url.password = 'fixture-not-a-secret';

  const listing = Bun.spawn(['git', 'ls-remote', url.href], {
    env: ctx.env,
    stdout: 'ignore',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    listing.kill();
  });

  await waitFor(() => {
    expect(waits).not.toBeEmpty();
  });

  const whileHeld = await Promise.race([listing.exited, Promise.resolve('held')]);

  release.resolve();

  const exitCode = await listing.exited;

  expect({ whileHeld, exitCode }).toStrictEqual({ whileHeld: 'held', exitCode: 0 });
  expect(waits).toSatisfyAll((ms: number) => ms === 400);
});

test('it calls back once for each authenticated request', async () => {
  await using ctx = await setupTest();

  let calls = 0;

  const hooked = startGitHTTPServer(ctx.dir, ctx.env, {
    onRequest: () => {
      calls += 1;
    },
  });

  onTestFinished(async () => {
    await hooked.stop();
  });

  const url = new URL('upstream.git', hooked.url);

  url.username = 'x-access-token';
  url.password = 'fixture-not-a-secret';

  const listed = await $`git ls-remote ${url.href}`.env(ctx.env).nothrow().quiet();

  expect(listed.exitCode).toBe(0);
  expect(hooked.authorizations).not.toBeEmpty();
  expect(calls).toBe(hooked.authorizations.length);
});

test('it holds a request while the callback is still pending', async () => {
  await using ctx = await setupTest();

  const entered = Promise.withResolvers<null>();
  const gate = Promise.withResolvers<null>();

  // The first request's callback waits on the gate; every later one returns
  // at once.
  const waits = [gate.promise];

  const hooked = startGitHTTPServer(ctx.dir, ctx.env, {
    onRequest: async () => {
      entered.resolve(null);

      await waits.shift();
    },
  });

  onTestFinished(async () => {
    await hooked.stop();
  });

  const url = `${hooked.url}upstream.git/info/refs?service=git-upload-pack`;
  const headers = { authorization: `Basic ${Buffer.from('atc:fixture').toString('base64')}` };
  const first = fetch(url, { headers });
  const firstSettled = Promise.allSettled([first]);

  onTestFinished(async () => {
    gate.resolve(null);

    await firstSettled;
  });

  await entered.promise;

  const later = await fetch(url, { headers });

  expect(later.status).toBe(200);
  expect(Bun.peek.status(first)).toBe('pending');
});

test('it answers a held request once the callback resolves', async () => {
  await using ctx = await setupTest();

  const entered = Promise.withResolvers<null>();
  const gate = Promise.withResolvers<null>();

  const hooked = startGitHTTPServer(ctx.dir, ctx.env, {
    onRequest: async () => {
      entered.resolve(null);

      await gate.promise;
    },
  });

  onTestFinished(async () => {
    await hooked.stop();
  });

  const response = fetch(`${hooked.url}upstream.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from('atc:fixture').toString('base64')}` },
  });

  await entered.promise;

  gate.resolve(null);

  const answer = await response;

  expect(answer.status).toBe(200);
});
