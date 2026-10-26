import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubGHReleases } from './create-stub-gh-releases';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-gh-releases-');

  return { directory: temporaryDirectory.path };
}

test('it lists the releases as gh release list --json tagName,isLatest prints them', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.3.0', isLatest: false },
    ],
  });

  const listed = await runCommand([
    join(gh.directory, 'gh'),
    'release',
    'list',
    '--json',
    'tagName,isLatest',
  ]);

  expect(JSON.parse(listed.stdout)).toStrictEqual([
    { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
    { tagName: '@zgeoff/atc@7.3.0', isLatest: false },
  ]);
});

test('it moves the latest mark to the edited release and records each call', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.4.0', isLatest: false },
    ],
  });

  await runCommand([join(gh.directory, 'gh'), 'release', 'edit', '@zgeoff/atc@7.4.0', '--latest']);

  expect(gh.readReleases()).toStrictEqual([
    { tagName: '@zgeoff/atc@7.3.1', isLatest: false },
    { tagName: '@zgeoff/atc@7.4.0', isLatest: true },
  ]);

  expect(gh.readCalls()).toStrictEqual(['release edit @zgeoff/atc@7.4.0 --latest']);
});

test('it publishes one rival before each edit lands, in order, and none once they run out', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.4.0', isLatest: false },
    ],
    rivals: ['@zgeoff/atc@7.4.1', '@zgeoff/atc@7.4.2'],
  });

  await runCommand([join(gh.directory, 'gh'), 'release', 'edit', '@zgeoff/atc@7.4.0', '--latest']);
  await runCommand([join(gh.directory, 'gh'), 'release', 'edit', '@zgeoff/atc@7.4.1', '--latest']);
  await runCommand([join(gh.directory, 'gh'), 'release', 'edit', '@zgeoff/atc@7.4.2', '--latest']);

  expect(gh.readReleases()).toStrictEqual([
    { tagName: '@zgeoff/atc@7.3.1', isLatest: false },
    { tagName: '@zgeoff/atc@7.4.0', isLatest: false },
    { tagName: '@zgeoff/atc@7.4.1', isLatest: false },
    { tagName: '@zgeoff/atc@7.4.2', isLatest: true },
  ]);
});

test('it fails a gh command it does not stand in for', async () => {
  const ctx = setupTest();
  const gh = createStubGHReleases(ctx.directory, { releases: [] });

  const viewed = await runCommand([join(gh.directory, 'gh'), 'repo', 'view']);

  expect({ exitCode: viewed.exitCode, stderr: viewed.stderr }).toStrictEqual({
    exitCode: 1,
    stderr: 'unexpected gh repo view\n',
  });
});
