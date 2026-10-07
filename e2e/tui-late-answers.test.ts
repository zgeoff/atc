import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { DaemonClient } from '../src/client/daemon-client';
import { buildStubHeldGH } from '../src/test-utils/build-stub-held-gh';
import { buildStubHeldZoxide } from '../src/test-utils/build-stub-held-zoxide';
import { buildStubSignedOutGH } from '../src/test-utils/build-stub-signed-out-gh';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { createStubBin } from '../src/test-utils/create-stub-bin';
import { KEYS } from '../src/test-utils/keys';
import { openRepoStep } from '../src/test-utils/open-repo-step';
import { startGitHTTPServer } from '../src/test-utils/start-git-http-server';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';
import { waitFor } from '../src/test-utils/wait-for';

function setupTest() {
  return startTUIHarness();
}

test('it stops a repository listing on esc and keeps taking typed input', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  // The repository listing answers only once the test removes the hold
  // file.
  writeFileSync(join(ctx.home, 'gh-hold'), '');
  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubHeldGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  await ctx.waitFor('listing…');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('listing stopped');

  const mark = ctx.markClientLog();

  rmSync(join(ctx.home, 'gh-hold'));

  await ctx.waitForClientLog('dropped listing answer', mark);

  expect(ctx.read()).toInclude('spawn: GitHub repository');
  expect(ctx.read()).not.toInclude('me/dots');

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');
}, 15_000);

test('it cancels a probe in flight on esc and drops its answer', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  const server = startGitHTTPServer(fixture.dir, fixture.env);

  onTestFinished(() => server.stop());

  // The home's git config supplies the basic auth the server asks for, so
  // the probe's request reaches the hold.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  server.hold();
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.reset();
  ctx.write(`${server.url}silent.git${KEYS.enter}`);

  await ctx.waitFor('checking access');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('cancelled');

  const mark = ctx.markClientLog();

  server.release();

  await ctx.waitForClientLog('dropped probe answer', mark);

  expect(ctx.read()).toInclude('spawn: GitHub repository');
  expect(ctx.read()).not.toInclude('clone_failed');

  ctx.reset();
  ctx.write(KEYS.ctrlU);

  await ctx.waitFor('> \u001B[93m█');

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');
}, 15_000);

test('it keeps the ref the user moved to when a repository listing answers late', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  await $`git push --quiet origin main:feat`.env(fixture.env).cwd(fixture.work).quiet();

  // The repository listing answers only once the test removes the hold
  // file.
  writeFileSync(join(ctx.home, 'gh-hold'), '');
  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubHeldGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor('spawn: ref');
  await ctx.waitFor('feat');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7mfeat');

  const mark = ctx.markClientLog();

  rmSync(join(ctx.home, 'gh-hold'));

  await ctx.waitForClientLog('kept the ref step through a listing answer', mark);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude(`feat → ${fixture.sha.slice(0, 12)}`);
}, 15_000);

test('it leaves the picker when esc stops waiting on a spawn, and the spawn lists one session', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  const server = startGitHTTPServer(fixture.dir, fixture.env);

  onTestFinished(() => server.stop());

  // The home's git config supplies the basic auth the server asks for.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx);

  ctx.reset();
  ctx.write(`${server.url}upstream.git${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(`slowclone${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  // The clone behind the spawn waits on the server until the test releases
  // it, so the spawn is still in flight when esc stops waiting on it.
  server.hold();
  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('esc stops waiting; the session still lists');

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor('atc — control tower');

  const mark = ctx.markClientLog();

  server.release();
  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('slowclone', 15_000);
  await ctx.waitForClientLog('dropped spawn answer', mark);

  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
  expect(ctx.read()).not.toInclude('spawn: initial prompt');

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toBeArrayOfSize(1);
}, 30_000);

test('it stays where the user moved when a directory listing answers late', async () => {
  await using ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  // The daemon runs zoxide from the PATH the client gives it. While the
  // hold file exists, zoxide marks that it started and waits, so the
  // directory listing answers only once the test removes the file.
  createStubBin(join(ctx.home, 'bin'), 'zoxide', buildStubHeldZoxide());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory on the daemon host');

  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: git URL');

  writeFileSync(join(ctx.home, 'zoxide-hold'), '');

  ctx.reset();
  ctx.write(KEYS.tab);

  // The tab draws nothing until the listing answers; zoxide starting shows
  // the daemon took the listing request.
  await waitFor(() => {
    expect(existsSync(join(ctx.home, 'zoxide-held'))).toBe(true);
  });

  ctx.write(KEYS.esc);

  await ctx.waitFor('spawn: agent');

  ctx.reset();

  const mark = ctx.markClientLog();

  rmSync(join(ctx.home, 'zoxide-hold'));

  await ctx.waitForClientLog('dropped directory listing answer', mark);

  expect(ctx.read()).not.toInclude('directory on the daemon host');
}, 15_000);

test('it keeps a probe started on a git source after a tab in that flow, spawning one git workspace', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  // While the hold file exists, zoxide marks that it started and waits, so
  // the tab's directory listing answers only once the test removes it.
  createStubBin(join(ctx.home, 'bin'), 'zoxide', buildStubHeldZoxide());

  const server = startGitHTTPServer(fixture.dir, fixture.env);

  onTestFinished(() => server.stop());

  // The home's git config supplies the basic auth the server asks for.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  const url = `${server.url}upstream.git`;

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory on the daemon host');

  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  ctx.write(url);

  await ctx.waitFor(`> ${url}`);

  writeFileSync(join(ctx.home, 'zoxide-hold'), '');

  server.hold();
  ctx.write(KEYS.tab);

  // The tab draws nothing until its listing answers; zoxide starting shows
  // the daemon took the listing request.
  await waitFor(() => {
    expect(existsSync(join(ctx.home, 'zoxide-held'))).toBe(true);
  });

  ctx.write(KEYS.enter);

  // The probe's request reaches the server and is held there, so the tab's
  // listing answers first.
  await waitFor(() => {
    expect(server.authorizations).not.toBeEmpty();
  });

  const mark = ctx.markClientLog();

  rmSync(join(ctx.home, 'zoxide-hold'));

  await ctx.waitForClientLog('dropped directory listing answer', mark);

  server.release();

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`, 10_000);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(`raced${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 20_000);

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toBeArrayOfSize(1);

  expect(listed['sessions']).toMatchObject([
    { name: 'raced', workspace: { repoURL: url, sha: fixture.sha, ref: 'main' } },
  ]);
}, 30_000);
