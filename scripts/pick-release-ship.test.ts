import { expect, test } from 'bun:test';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';
import { pickReleaseShip } from './pick-release-ship';

test.each([
  {
    label: 'a tag on this commit whose checks passed',
    run: {
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: '{"sha":"4e1c2a9"}',
      checksResult: 'success',
      binariesResult: 'success',
    },
    expected: 'here',
  },
  {
    label: 'a tag whose checks a newer push cancelled',
    run: {
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: '{"sha":"4e1c2a9"}',
      checksResult: 'skipped',
      binariesResult: 'success',
    },
    expected: 'dispatch',
  },
  {
    label: 'a tag whose checks failed',
    run: {
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: '{"sha":"4e1c2a9"}',
      checksResult: 'failure',
      binariesResult: 'success',
    },
    expected: 'dispatch',
  },
  {
    label: 'a tag whose binaries failed',
    run: {
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: '{"sha":"4e1c2a9"}',
      checksResult: 'success',
      binariesResult: 'failure',
    },
    expected: 'dispatch',
  },
  {
    label: 'a tag on another commit',
    run: {
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: '{"sha":"b83f017"}',
      checksResult: 'success',
      binariesResult: 'success',
    },
    expected: 'dispatch',
  },
  {
    label: 'a tag of the root package and the gateway on this commit whose checks passed',
    run: {
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: JSON.stringify({
        sha: '4e1c2a9',
        'packages/gateway--sha': '4e1c2a9',
        paths_released: '[".","packages/gateway"]',
      }),
      checksResult: 'success',
      binariesResult: 'success',
    },
    expected: 'here',
  },
  {
    label: 'a tag of the gateway alone',
    run: {
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: JSON.stringify({
        'packages/gateway--sha': '4e1c2a9',
        paths_released: '["packages/gateway"]',
      }),
      checksResult: 'success',
      binariesResult: 'success',
    },
    expected: 'none',
  },
  {
    label: 'a push that tagged nothing',
    run: {
      event: 'push',
      releasesCreated: 'false',
      releaseOutputs: '{}',
      checksResult: 'success',
      binariesResult: 'success',
    },
    expected: 'none',
  },
  {
    label: 'a dispatch whose checks passed',
    run: {
      event: 'workflow_dispatch',
      releasesCreated: '',
      releaseOutputs: '',
      checksResult: 'success',
      binariesResult: 'success',
    },
    expected: 'here',
  },
  {
    label: 'a dispatch whose checks failed',
    run: {
      event: 'workflow_dispatch',
      releasesCreated: '',
      releaseOutputs: '',
      checksResult: 'failure',
      binariesResult: 'success',
    },
    expected: 'none',
  },
])('it picks the ship for $label', (row) => {
  expect(pickReleaseShip({ ...row.run, sha: '4e1c2a9' })).toBe(row.expected);
});

test('it refuses release outputs that hold no tagged commit', () => {
  expect(() =>
    pickReleaseShip({
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs: '{"tag_name":"@zgeoff/atc@3.1.4"}',
      checksResult: 'success',
      binariesResult: 'success',
      sha: '4e1c2a9',
    }),
  ).toThrowWithMessage(Error, /hold no tagged commit/u);
});

test.each([
  ['release outputs that are not an object', '"tagged"', /are not an object/u],
  [
    'release outputs whose released paths are not a list',
    JSON.stringify({ sha: '4e1c2a9', paths_released: '"."' }),
    /list no released paths/u,
  ],
])('it refuses %s', (_label, releaseOutputs, message) => {
  expect(() =>
    pickReleaseShip({
      event: 'push',
      releasesCreated: 'true',
      releaseOutputs,
      checksResult: 'success',
      binariesResult: 'success',
      sha: '4e1c2a9',
    }),
  ).toThrowWithMessage(Error, message);
});

test('it runs from a folder with no installed packages, as the release job runs it', async () => {
  const directory = setupTempDir('pick-release-ship-bare-');
  const output = join(directory.path, 'output');
  const script = join(directory.path, 'pick-release-ship.ts');

  copyFileSync(join(import.meta.dir, 'pick-release-ship.ts'), script);

  const picked = await runCommand(['bun', '--no-install', script], {
    cwd: directory.path,
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: '4e1c2a9',
      RELEASES_CREATED: 'true',
      RELEASE_OUTPUTS: JSON.stringify({ sha: '4e1c2a9', paths_released: '["."]' }),
      CHECKS_RESULT: 'success',
      BINARIES_RESULT: 'success',
    },
  });

  expect(picked.exitCode).toBe(0);
  expect(readFileSync(output, 'utf8')).toBe('ship=here\n');
});

test('it writes the picked ship to the step output', async () => {
  const directory = setupTempDir('pick-release-ship-');
  const output = join(directory.path, 'output');

  const picked = await runCommand(['bun', join(import.meta.dir, 'pick-release-ship.ts')], {
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: '4e1c2a9',
      RELEASES_CREATED: 'true',
      RELEASE_OUTPUTS: '{"sha":"4e1c2a9"}',
      CHECKS_RESULT: 'cancelled',
      BINARIES_RESULT: 'success',
    },
  });

  expect(picked.exitCode).toBe(0);
  expect(readFileSync(output, 'utf8')).toBe('ship=dispatch\n');
});
