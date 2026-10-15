import { expect, test } from 'bun:test';
import { planTestRuns } from './plan-test-runs';

test('it plans one run of every file when nothing is skipped', () => {
  expect(planTestRuns(['src/a.test.ts', 'src/b.test.ts'], [])).toStrictEqual([
    { args: ['src/a.test.ts', 'src/b.test.ts'], skips: [] },
  ]);
});

test('it ignores an entry for a file that is not selected', () => {
  expect(
    planTestRuns(
      ['src/a.test.ts'],
      [{ file: 'src/b.test.ts', test: 'it trims the hedge', issue: 'GEO-18' }],
    ),
  ).toStrictEqual([{ args: ['src/a.test.ts'], skips: [] }]);
});

test('it gives a file with skipped tests a run of its own that filters out their names', () => {
  expect(
    planTestRuns(
      ['src/a.test.ts', 'src/b.test.ts'],
      [
        { file: 'src/b.test.ts', test: 'it trims the hedge', issue: 'GEO-18' },
        { file: 'src/b.test.ts', test: 'it rakes the leaves', issue: 'GEO-19' },
      ],
    ),
  ).toStrictEqual([
    { args: ['src/a.test.ts'], skips: [] },
    {
      args: [
        'src/b.test.ts',
        '--pass-with-no-tests',
        '--test-name-pattern',
        '^(?!(?:it trims the hedge|it rakes the leaves)$)',
      ],
      skips: [
        { file: 'src/b.test.ts', test: 'it trims the hedge', issue: 'GEO-18' },
        { file: 'src/b.test.ts', test: 'it rakes the leaves', issue: 'GEO-19' },
      ],
    },
  ]);
});

test('it plans no plain run when every selected file has a skipped test', () => {
  expect(
    planTestRuns(
      ['src/b.test.ts'],
      [{ file: 'src/b.test.ts', test: 'it trims the hedge', issue: 'GEO-18' }],
    ),
  ).toStrictEqual([
    {
      args: [
        'src/b.test.ts',
        '--pass-with-no-tests',
        '--test-name-pattern',
        '^(?!(?:it trims the hedge)$)',
      ],
      skips: [{ file: 'src/b.test.ts', test: 'it trims the hedge', issue: 'GEO-18' }],
    },
  ]);
});

test('it escapes the regular expression characters in a test name', () => {
  const [run] = planTestRuns(
    ['src/b.test.ts'],
    [{ file: 'src/b.test.ts', test: 'it waters (some) tulips.*', issue: 'GEO-18' }],
  );

  expect(run?.args.at(-1)).toBe(String.raw`^(?!(?:it waters \(some\) tulips\.\*)$)`);
});
