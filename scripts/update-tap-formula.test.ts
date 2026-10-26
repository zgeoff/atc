import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createGitFixture, createStubRivalTapPush, runCommand } from '@atc/test-utils';

// The fixture's bare upstream stands in for the tap, and its directory holds
// the release's working directory, its SHA256SUMS and the rival's hook.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'update-tap-formula-' });

  return { fixture };
}

test('it keeps a newer formula that a competing push wrote while it cloned the tap', async () => {
  const ctx = await setupTest();

  const sums = join(ctx.fixture.directory, 'SHA256SUMS');
  const release = join(ctx.fixture.directory, 'release');

  await Bun.write(
    sums,
    'aa  atc-darwin-arm64\nbb  atc-darwin-x64\ncc  atc-linux-arm64\ndd  atc-linux-x64\n',
  );

  await Bun.write(join(release, '.keep'), '');

  const newer = await runCommand([
    'bash',
    join(import.meta.dir, 'build-formula.sh'),
    '7.10.0',
    sums,
  ]);

  const rival = createStubRivalTapPush(join(ctx.fixture.directory, 'rival'), {
    remote: ctx.fixture.upstream,
    formula: newer.stdout,
  });

  const updated = await runCommand(
    ['bash', join(import.meta.dir, 'update-tap-formula.sh'), ctx.fixture.upstream, '7.3.1', sums],
    { cwd: release, env: { ...ctx.fixture.env, GIT_CONFIG_GLOBAL: rival.gitConfig } },
  );

  const held = await runCommand(
    ['git', '--git-dir', ctx.fixture.upstream, 'show', 'main:Formula/atc.rb'],
    { env: ctx.fixture.env },
  );

  const subjects = await runCommand(
    ['git', '--git-dir', ctx.fixture.upstream, 'log', '--format=%s', 'main'],
    { env: ctx.fixture.env },
  );

  expect(updated.exitCode).toBe(0);
  expect(held.stdout).toBe(newer.stdout);
  expect(subjects.stdout).toBe('rival\ninitial\n');
});

test('it writes its formula on a second clone after a competing push of an older one', async () => {
  const ctx = await setupTest();

  const sums = join(ctx.fixture.directory, 'SHA256SUMS');
  const release = join(ctx.fixture.directory, 'release');

  await Bun.write(
    sums,
    'aa  atc-darwin-arm64\nbb  atc-darwin-x64\ncc  atc-linux-arm64\ndd  atc-linux-x64\n',
  );

  await Bun.write(join(release, '.keep'), '');

  const older = await runCommand([
    'bash',
    join(import.meta.dir, 'build-formula.sh'),
    '7.3.0',
    sums,
  ]);

  const released = await runCommand([
    'bash',
    join(import.meta.dir, 'build-formula.sh'),
    '7.3.1',
    sums,
  ]);

  const rival = createStubRivalTapPush(join(ctx.fixture.directory, 'rival'), {
    remote: ctx.fixture.upstream,
    formula: older.stdout,
  });

  const updated = await runCommand(
    ['bash', join(import.meta.dir, 'update-tap-formula.sh'), ctx.fixture.upstream, '7.3.1', sums],
    { cwd: release, env: { ...ctx.fixture.env, GIT_CONFIG_GLOBAL: rival.gitConfig } },
  );

  const held = await runCommand(
    ['git', '--git-dir', ctx.fixture.upstream, 'show', 'main:Formula/atc.rb'],
    { env: ctx.fixture.env },
  );

  const subjects = await runCommand(
    ['git', '--git-dir', ctx.fixture.upstream, 'log', '--format=%s', 'main'],
    { env: ctx.fixture.env },
  );

  expect(updated.exitCode).toBe(0);
  expect(held.stdout).toBe(released.stdout);
  expect(subjects.stdout).toBe('atc 7.3.1\nrival\ninitial\n');
});
