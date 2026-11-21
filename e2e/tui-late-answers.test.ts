import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAgentStep } from '@atc/app/test-utils/open-agent-step';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { tabToRepoRows } from '@atc/app/test-utils/tab-to-repo-rows';
import { createGitFixture } from '@atc/core/test-utils/create-git-fixture';
import { KEYS } from '@atc/core/test-utils/keys';
import { startGitHTTPServer } from '@atc/daemon/test-utils/start-git-http-server';
import { createDaemonClient } from '@atc/protocol/client';
import { buildStubHeldZoxide } from '@atc/source-dirs/test-utils/build-stub-held-zoxide';
import { buildStubHeldGH } from '@atc/source-github/test-utils/build-stub-held-gh';
import { buildStubSignedOutGH } from '@atc/source-github/test-utils/build-stub-signed-out-gh';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createStubBin } from '@zgeoff/testing/bin';
import { $ } from 'bun';

function setupTest() {
  return startTUIHarness({ createStateDB: createMigratedStateDB });
}

test('it stops a repository listing on esc to the agent step and lists again on the next pick', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  writeFileSync(join(ctx.home, 'gh-hold'), '');
  createStubBin(join(ctx.home, 'bin'), 'gh', { script: buildStubHeldGH() });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await tabToRepoRows(ctx);

  await waitFor(() => {
    expect(existsSync(join(ctx.home, 'gh-held'))).toBe(true);
  });

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: agent');

  const mark = ctx.countClientLogLines();

  rmSync(join(ctx.home, 'gh-hold'));

  await ctx.waitForClientLog('dropped listing answer', mark);

  expect(ctx.read()).not.toInclude('me/dots');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  ctx.reset();
  ctx.write(`file://${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');
});

test('it cancels a probe in flight on esc and drops its answer', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', { script: buildStubSignedOutGH() });

  const gate = Promise.withResolvers<void>();

  const server = startGitHTTPServer(fixture.directory, fixture.env, {
    onRequest: () => gate.promise,
  });

  // The server asks for basic auth, so without credentials the request would never get past it.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await tabToRepoRows(ctx);

  ctx.write(`${server.url}silent.git${KEYS.enter}`);

  await waitFor(() => {
    expect(server.authorizations).not.toBeEmpty();
  });

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('cancelled');

  const mark = ctx.countClientLogLines();

  gate.resolve();

  await ctx.waitForClientLog('dropped probe answer', mark);

  expect(ctx.read()).toInclude('spawn: workspace');
  expect(ctx.read()).not.toInclude('clone_failed');

  ctx.reset();
  ctx.write(KEYS.ctrlU);

  await ctx.waitFor('> █');

  ctx.reset();
  ctx.write(`file://${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');
});

test('it keeps the ref the user moved to when a repository listing answers late', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  await $`git push --quiet origin main:feat`.env(fixture.env).cwd(fixture.work).quiet();

  writeFileSync(join(ctx.home, 'gh-hold'), '');
  createStubBin(join(ctx.home, 'bin'), 'gh', { script: buildStubHeldGH() });

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await tabToRepoRows(ctx);

  ctx.reset();
  ctx.write(`file://${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');
  await ctx.waitFor('feat');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7mfeat');

  const mark = ctx.countClientLogLines();

  rmSync(join(ctx.home, 'gh-hold'));

  await ctx.waitForClientLog('kept the ref step through a listing answer', mark);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude(`feat → ${fixture.sha.slice(0, 12)}`);
});

test('it leaves the picker when esc stops waiting on a spawn, and the spawn lists one session', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', { script: buildStubSignedOutGH() });

  const gate = Promise.withResolvers<void>();
  let hold = Promise.resolve();
  const server = startGitHTTPServer(fixture.directory, fixture.env, { onRequest: () => hold });

  // The server asks for basic auth, which git config in the home supplies.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await tabToRepoRows(ctx);

  ctx.reset();
  ctx.write(`${server.url}upstream.git${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(`slowclone${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  // The spawn must still be in flight when esc stops waiting on it, so the clone waits on the server until the test releases it.
  hold = gate.promise;

  const served = server.authorizations.length;

  ctx.write(KEYS.enter);

  await waitFor(() => {
    expect(server.authorizations.length).toBeGreaterThan(served);
  });

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('atc — control tower');

  const mark = ctx.countClientLogLines();

  gate.resolve();
  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('slowclone', 10_000);
  await ctx.waitForClientLog('dropped spawn answer', mark);

  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
  expect(ctx.read()).not.toInclude('spawn: initial prompt');

  const daemon = createDaemonClient(ctx.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toBeArrayOfSize(1);
});

test('it stays where the user moved when a directory listing answers late', async () => {
  const ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', { script: buildStubSignedOutGH() });

  // The daemon runs zoxide from the PATH the client gives it.
  createStubBin(join(ctx.home, 'bin'), 'zoxide', { script: buildStubHeldZoxide() });
  writeFileSync(join(ctx.home, 'zoxide-hold'), '');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  await waitFor(() => {
    expect(existsSync(join(ctx.home, 'zoxide-held'))).toBe(true);
  });

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: agent');

  ctx.reset();

  const mark = ctx.countClientLogLines();

  rmSync(join(ctx.home, 'zoxide-hold'));

  await ctx.waitForClientLog('dropped directory listing answer', mark);

  expect(ctx.read()).not.toInclude('spawn: workspace');
});

test('it keeps a probe of a typed URL while the directory listing answers, spawning one git workspace', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', { script: buildStubSignedOutGH() });
  createStubBin(join(ctx.home, 'bin'), 'zoxide', { script: buildStubHeldZoxide() });
  writeFileSync(join(ctx.home, 'zoxide-hold'), '');

  const gate = Promise.withResolvers<void>();
  let hold = Promise.resolve();
  const server = startGitHTTPServer(fixture.directory, fixture.env, { onRequest: () => hold });

  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  const url = `${server.url}upstream.git`;

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openAgentStep(ctx);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: workspace');

  await waitFor(() => {
    expect(existsSync(join(ctx.home, 'zoxide-held'))).toBe(true);
  });

  ctx.reset();
  ctx.write(url);

  await ctx.waitFor(ctx.formatInput(url));

  hold = gate.promise;

  ctx.write(KEYS.enter);

  await waitFor(() => {
    expect(server.authorizations).not.toBeEmpty();
  });

  ctx.reset();

  rmSync(join(ctx.home, 'zoxide-hold'));

  await ctx.waitFor('checking access to');

  gate.resolve();

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`, 10_000);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(`raced${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);

  const daemon = createDaemonClient(ctx.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toBeArrayOfSize(1);

  expect(listed['sessions']).toMatchObject([
    { name: 'raced', workspace: { repoURL: url, sha: fixture.sha, ref: 'main' } },
  ]);
});
