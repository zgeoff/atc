import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
