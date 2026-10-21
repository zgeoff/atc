import { expect, test } from 'bun:test';
import { buildMockRestartResult } from '@atc/test-utils';
import { formatRestartDetail } from './format-restart-detail';

test('it states the restored count of a clean restart', () => {
  expect(formatRestartDetail(buildMockRestartResult({ restored: 3, total: 3 }))).toBe(
    'restored 3 of 3',
  );
});

test('it counts the failed and interrupted rows and the exit code of a partial restore', () => {
  expect(
    formatRestartDetail(
      buildMockRestartResult({
        code: 1,
        restored: 1,
        total: 3,
        failed: [{ name: 'otter', id: 's-otter', reason: 'its agent is not configured' }],
        interrupted: [{ name: 'wren', id: 's-wren' }],
      }),
    ),
  ).toBe('restored 1 of 3, 1 failed, 1 interrupted mid-turn, exit code 1');
});

test('it states the error of a restart that failed before it restored', () => {
  expect(
    formatRestartDetail(
      buildMockRestartResult({
        code: 1,
        total: 2,
        error: 'the replacement daemon never answered',
      }),
    ),
  ).toBe('restart failed: the replacement daemon never answered');
});
