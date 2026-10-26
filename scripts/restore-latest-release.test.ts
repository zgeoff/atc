import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubGHReleases, runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory for the stub gh and its release state.
function setupTest() {
  const temporaryDirectory = setupTempDir('restore-latest-release-');

  return { directory: temporaryDirectory.path };
}

test('it leaves the latest mark on a release-branch release that is the newest', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.3.0', isLatest: false },
    ],
  });

  const restored = await runCommand(
    ['bash', join(import.meta.dir, 'restore-latest-release.sh'), 'zgeoff/atc'],
    { env: { ...process.env, PATH: `${gh.directory}:${process.env['PATH'] ?? ''}` } },
  );

  expect(restored.exitCode).toBe(0);

  expect(gh.readReleases()).toStrictEqual([
    { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
    { tagName: '@zgeoff/atc@7.3.0', isLatest: false },
  ]);

  expect(gh.readCalls()).toStrictEqual([
    'release list --repo zgeoff/atc --exclude-drafts --exclude-pre-releases --limit 10000 --json tagName,isLatest',
  ]);
});

test('it moves the latest mark from an older release-branch release to the newest release', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.10.0', isLatest: false },
      { tagName: '@zgeoff/atc@7.3.0', isLatest: false },
    ],
  });

  const restored = await runCommand(
    ['bash', join(import.meta.dir, 'restore-latest-release.sh'), 'zgeoff/atc'],
    { env: { ...process.env, PATH: `${gh.directory}:${process.env['PATH'] ?? ''}` } },
  );

  expect(restored.exitCode).toBe(0);

  expect(gh.readReleases()).toStrictEqual([
    { tagName: '@zgeoff/atc@7.3.1', isLatest: false },
    { tagName: '@zgeoff/atc@7.10.0', isLatest: true },
    { tagName: '@zgeoff/atc@7.3.0', isLatest: false },
  ]);

  expect(gh.readCalls().filter((call) => call.startsWith('release edit'))).toStrictEqual([
    'release edit @zgeoff/atc@7.10.0 --latest --repo zgeoff/atc',
  ]);
});

test('it moves the latest mark again when a main release lands between its read and its edit', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.4.0', isLatest: false },
    ],
    rival: '@zgeoff/atc@7.4.1',
  });

  const restored = await runCommand(
    ['bash', join(import.meta.dir, 'restore-latest-release.sh'), 'zgeoff/atc'],
    { env: { ...process.env, PATH: `${gh.directory}:${process.env['PATH'] ?? ''}` } },
  );

  expect(restored.exitCode).toBe(0);

  expect(gh.readReleases()).toStrictEqual([
    { tagName: '@zgeoff/atc@7.3.1', isLatest: false },
    { tagName: '@zgeoff/atc@7.4.0', isLatest: false },
    { tagName: '@zgeoff/atc@7.4.1', isLatest: true },
  ]);

  expect(gh.readCalls().filter((call) => call.startsWith('release edit'))).toStrictEqual([
    'release edit @zgeoff/atc@7.4.0 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.1 --latest --repo zgeoff/atc',
  ]);
});
