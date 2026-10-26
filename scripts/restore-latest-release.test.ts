import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
    rivals: ['@zgeoff/atc@7.4.1'],
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

test('it succeeds when its fifth edit leaves the latest mark on the newest release', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.4.0', isLatest: false },
    ],
    rivals: ['@zgeoff/atc@7.4.1', '@zgeoff/atc@7.4.2', '@zgeoff/atc@7.4.3', '@zgeoff/atc@7.4.4'],
  });

  const restored = await runCommand(
    ['bash', join(import.meta.dir, 'restore-latest-release.sh'), 'zgeoff/atc'],
    { env: { ...process.env, PATH: `${gh.directory}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: restored.exitCode, stderr: restored.stderr }).toStrictEqual({
    exitCode: 0,
    stderr: '',
  });

  expect(gh.readReleases().filter((release) => release.isLatest)).toStrictEqual([
    { tagName: '@zgeoff/atc@7.4.4', isLatest: true },
  ]);

  expect(gh.readCalls().filter((call) => call.startsWith('release edit'))).toStrictEqual([
    'release edit @zgeoff/atc@7.4.0 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.1 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.2 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.3 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.4 --latest --repo zgeoff/atc',
  ]);
});

test('it fails after 5 edits when a newer release takes the latest mark before each one lands', async () => {
  const ctx = setupTest();

  const gh = createStubGHReleases(ctx.directory, {
    releases: [
      { tagName: '@zgeoff/atc@7.3.1', isLatest: true },
      { tagName: '@zgeoff/atc@7.4.0', isLatest: false },
    ],
    rivals: [
      '@zgeoff/atc@7.4.1',
      '@zgeoff/atc@7.4.2',
      '@zgeoff/atc@7.4.3',
      '@zgeoff/atc@7.4.4',
      '@zgeoff/atc@7.4.5',
    ],
  });

  const restored = await runCommand(
    ['bash', join(import.meta.dir, 'restore-latest-release.sh'), 'zgeoff/atc'],
    { env: { ...process.env, PATH: `${gh.directory}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: restored.exitCode, stderr: restored.stderr }).toStrictEqual({
    exitCode: 1,
    stderr: 'the latest mark did not settle on the newest release\n',
  });

  expect(gh.readCalls().filter((call) => call.startsWith('release edit'))).toStrictEqual([
    'release edit @zgeoff/atc@7.4.0 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.1 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.2 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.3 --latest --repo zgeoff/atc',
    'release edit @zgeoff/atc@7.4.4 --latest --repo zgeoff/atc',
  ]);
});

test('it runs in the main workflow after each created release, in the group every branch shares', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../.github/workflows/main.yml'), 'utf8'),
  );

  expect(workflow).toMatchObject({
    jobs: {
      release: {
        outputs: { releases_created: `\${{ steps.release.outputs.releases_created }}` },
      },
      'latest-release': {
        needs: ['release'],
        if: `\${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
        concurrency: { group: 'atc-latest-release', 'cancel-in-progress': false },
        permissions: { contents: 'write' },
        steps: expect.arrayContaining([
          expect.objectContaining({
            run: 'scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
          }),
        ]),
      },
    },
  });
});
