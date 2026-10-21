import { expect, test } from 'bun:test';
import { formatRestartDetail } from './format-restart-detail';

test('it states the restored count of a clean restart', () => {
  expect(
    formatRestartDetail({
      runID: 'run-cedar',
      code: 0,
      pid: 5150,
      build: 'atc/0.9.2',
      listenPort: null,
      restored: 3,
      total: 3,
      failed: [],
      interrupted: [],
      error: null,
    }),
  ).toBe('restored 3 of 3');
});

test('it counts the failed and interrupted rows and the exit code of a partial restore', () => {
  expect(
    formatRestartDetail({
      runID: 'run-birch',
      code: 1,
      pid: 5151,
      build: 'atc/0.9.2',
      listenPort: 7420,
      restored: 1,
      total: 3,
      failed: [{ name: 'otter', id: 's-otter', reason: 'its agent is not configured' }],
      interrupted: [{ name: 'wren', id: 's-wren' }],
      error: null,
    }),
  ).toBe('restored 1 of 3, 1 failed, 1 interrupted mid-turn, exit code 1');
});

test('it states the error of a restart that failed before it restored', () => {
  expect(
    formatRestartDetail({
      runID: 'run-alder',
      code: 1,
      pid: null,
      build: null,
      listenPort: null,
      restored: 0,
      total: 2,
      failed: [],
      interrupted: [],
      error: 'the replacement daemon never answered',
    }),
  ).toBe('restart failed: the replacement daemon never answered');
});
