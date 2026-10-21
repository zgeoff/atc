import { expect, test } from 'bun:test';
import { buildMockRestartResult } from './build-mock-restart-result';

test('it builds a default restart result', () => {
  expect(buildMockRestartResult()).toStrictEqual({
    runID: expect.toBeString(),
    code: 0,
    pid: expect.toBeNumber(),
    build: expect.toStartWith('atc/'),
    listenPort: null,
    restored: 0,
    total: 0,
    failed: [],
    interrupted: [],
    error: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockRestartResult({
      code: 1,
      restored: 1,
      total: 2,
      failed: [{ name: 'osprey', id: 's-osprey', reason: 'its agent is not configured' }],
    }),
  ).toStrictEqual({
    runID: expect.toBeString(),
    code: 1,
    pid: expect.toBeNumber(),
    build: expect.toStartWith('atc/'),
    listenPort: null,
    restored: 1,
    total: 2,
    failed: [{ name: 'osprey', id: 's-osprey', reason: 'its agent is not configured' }],
    interrupted: [],
    error: null,
  });
});
