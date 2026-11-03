import { expect, test } from 'bun:test';
import { pickWorkspaceEligibility } from './pick-workspace-eligibility';

test('it sends a ready workspace of an ended session to the check', () => {
  expect(
    pickWorkspaceEligibility({
      row: { target: 'local', directory: '/srv/work/bakery-9', phase: 'ready', sha: 'c0ffee1' },
      target: 'local',
      harnessEnded: true,
      bindingRefusal: null,
    }),
  ).toStrictEqual({ kind: 'check', directory: '/srv/work/bakery-9', sha: 'c0ffee1' });
});

test.each([
  ['no row', null],
  [
    'a build that never finished',
    { target: 'local', directory: '/srv/work/bakery-9', phase: 'cloning', sha: null },
  ],
  [
    'a row of another target',
    { target: 'cloud', directory: '/srv/work/bakery-9', phase: 'ready', sha: 'c0ffee1' },
  ],
])('it reports no workspace of atc for %s', (_case, row) => {
  expect(
    pickWorkspaceEligibility({ row, target: 'local', harnessEnded: true, bindingRefusal: null }),
  ).toStrictEqual({ kind: 'none' });
});

test('it keeps the workspace of a session whose process atc did not see exit', () => {
  expect(
    pickWorkspaceEligibility({
      row: { target: 'local', directory: '/srv/work/bakery-9', phase: 'ready', sha: 'c0ffee1' },
      target: 'local',
      harnessEnded: false,
      bindingRefusal: null,
    }),
  ).toStrictEqual({
    kind: 'kept',
    path: '/srv/work/bakery-9',
    reason: "unchecked: atc could not confirm that the session's process exited",
  });
});

test('it keeps the workspace of a session its target now refuses to run', () => {
  expect(
    pickWorkspaceEligibility({
      row: { target: 'local', directory: '/srv/work/bakery-9', phase: 'ready', sha: 'c0ffee1' },
      target: 'local',
      harnessEnded: true,
      bindingRefusal: 'target local changed since the session started',
    }),
  ).toStrictEqual({
    kind: 'kept',
    path: '/srv/work/bakery-9',
    reason: 'unchecked: target local changed since the session started',
  });
});

test.each([
  ['no commit', { directory: '/srv/work/bakery-9', sha: null }],
  ['a relative folder', { directory: 'work/bakery-9', sha: 'c0ffee1' }],
])('it keeps a workspace recorded with %s', (_case, recorded) => {
  expect(
    pickWorkspaceEligibility({
      row: { target: 'local', phase: 'ready', ...recorded },
      target: 'local',
      harnessEnded: true,
      bindingRefusal: null,
    }),
  ).toStrictEqual({
    kind: 'kept',
    path: recorded.directory,
    reason: 'unchecked: atc recorded no commit or no absolute folder for it',
  });
});
