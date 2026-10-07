import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { DaemonClient } from '../src/client/daemon-client';
import { buildStubSignedInGH } from '../src/test-utils/build-stub-signed-in-gh';
import { buildStubSignedOutGH } from '../src/test-utils/build-stub-signed-out-gh';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { createStubBin } from '../src/test-utils/create-stub-bin';
import { KEYS } from '../src/test-utils/keys';
import { startStubSourceDaemon } from '../src/test-utils/start-stub-source-daemon';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';

function setupTest() {
  return startTUIHarness();
}

test('it keeps paths and slash filters in the local directory step and switches source on tab or a pasted URL', async () => {
  await using ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write('~/');

  await ctx.waitFor('> ~/');

  ctx.reset();
  ctx.write(KEYS.ctrlU);

  await ctx.waitFor('> \u001B[93m█');

  ctx.write('atc/src');

  await ctx.waitFor('> atc/src');

  expect(ctx.read()).not.toInclude('spawn: GitHub repository');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: directory on the daemon host');

  ctx.reset();
  ctx.write('https://github.com/acme/app.git');

  await ctx.waitFor('spawn: GitHub repository');

  expect(ctx.read()).toInclude('> https://github.com/acme/app.git');
}, 20_000);

test('it drives a source the daemon composition adds from its candidates to the confirm screen', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  await using daemons = new AsyncDisposableStack();

  const sourceDaemon = await startStubSourceDaemon({
    ...ctx.env,
    ATC_TEST_FIXTURE_URL: fixture.upstream,
  });

  daemons.use(sourceDaemon);
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory on the daemon host');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('upstream  fixture');

  expect(ctx.read()).toInclude('spawn: fixture repository');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude(`source  ${fixture.upstream}`);
}, 30_000);

test('it spawns the repository a composed source reads typed text as, through to its workspace', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  await using daemons = new AsyncDisposableStack();

  const sourceDaemon = await startStubSourceDaemon({
    ...ctx.env,
    ATC_TEST_FIXTURE_URL: fixture.upstream,
  });

  daemons.use(sourceDaemon);
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory on the daemon host');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('upstream  fixture');

  ctx.reset();
  ctx.write('pick upstream');

  await ctx.waitFor('> pick upstream');

  ctx.write(KEYS.enter);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`, 10_000);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: confirm');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  ctx.write(`picked${KEYS.enter}`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.write(KEYS.enter);

  await ctx.waitFor('FAKE_CLAUDE_UP', 20_000);

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    {
      name: 'picked',
      cwd: join(
        ctx.home,
        '.local',
        'share',
        'atc',
        'workspaces',
        `upstream-main-${fixture.sha.slice(0, 7)}`,
      ),
      workspace: { repoURL: fixture.upstream, sha: fixture.sha, ref: 'main' },
    },
  ]);
}, 60_000);

test('it lists the scope a composed source reads from a directory step once, on the target chosen next', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  const listLog = join(ctx.home, 'source-lists.jsonl');

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.writeConfig({
    targets: { local: { provider: 'local-pty' }, alt: { provider: 'local-pty', tag: 'alt' } },
    defaultTarget: 'local',
  });

  await using daemons = new AsyncDisposableStack();

  const sourceDaemon = await startStubSourceDaemon({
    ...ctx.env,
    ATC_TEST_FIXTURE_URL: fixture.upstream,
    ATC_TEST_SOURCE_LOG: listLog,
  });

  daemons.use(sourceDaemon);
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory on the daemon host');

  ctx.reset();
  ctx.write('in acme');

  await ctx.waitFor('> in acme');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: target');

  ctx.reset();
  ctx.write(KEYS.down);

  await ctx.waitFor('\u001B[7malt  local-pty');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('acme/upstream  fixture');

  expect(ctx.read()).toInclude('spawn: fixture repository · acme');

  const lists = readFileSync(listLog, 'utf8').trim().split('\n');

  expect(lists.map((line): unknown => JSON.parse(line))).toStrictEqual([
    { scope: 'acme', target: 'alt' },
  ]);
}, 30_000);

test('it offers the local directory flow alone when the daemon offers no sources', async () => {
  await using ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  await using daemons = new AsyncDisposableStack();

  const sourceDaemon = await startStubSourceDaemon({ ...ctx.env, ATC_TEST_SOURCES: 'none' });

  daemons.use(sourceDaemon);
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  // The picker offers another source only through the tab hint on the
  // step's last row, so its absence is the offer under test.
  expect(ctx.read()).not.toInclude(' · tab ');
  expect(ctx.read()).not.toInclude('on the daemon host');

  ctx.reset();

  const mark = ctx.markClientLog();

  ctx.write(KEYS.tab);

  await ctx.waitForClientLog('ignored tab with one source', mark);

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: name');

  expect(ctx.read()).not.toInclude('spawn: GitHub repository');
}, 30_000);

test('it lists an owner typed in the directory step through the source that reads it', async () => {
  await using ctx = setupTest();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedInGH());

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write(`acme/${KEYS.enter}`);

  await ctx.waitFor('spawn: GitHub repository · acme');
  await ctx.waitFor('acme/app  private');
}, 20_000);

test('it probes a repository typed in the directory step at the URL its source reads it as', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());
  mkdirSync(join(ctx.home, 'mirror', 'acme'), { recursive: true });

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${join(ctx.home, 'mirror', 'acme', 'app.git')}`
    .env(fixture.env)
    .quiet();

  // The daemon reads the home's git config, which sends the https form of
  // acme/app to the mirror, so no request reaches GitHub.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    `[url "file://${join(ctx.home, 'mirror')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  ctx.write(`acme/app${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('source  https://github.com/acme/app.git');
}, 30_000);

test('it opens the sources in the order the config gives', async () => {
  await using ctx = setupTest();
  await using fixture = await createGitFixture();

  createStubBin(join(ctx.home, 'bin'), 'gh', buildStubSignedOutGH());

  ctx.writeConfig({ workspaces: { sources: ['git', 'dirs'] } });
  ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.reset();
  ctx.write(KEYS.enter);

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  ctx.write(`${fixture.upstream}${KEYS.enter}`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  ctx.write(KEYS.esc);

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  ctx.write(KEYS.tab);

  await ctx.waitFor('spawn: directory on the daemon host');

  expect(ctx.read()).not.toInclude('GitHub');
}, 30_000);
