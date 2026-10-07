import { expect, test } from 'bun:test';
import { formatRestartReport } from './format-restart-report';

test('it reports a clean restart with the daemon, the count, and the interrupted sessions', () => {
  const lines = formatRestartReport({
    runID: 'r1',
    code: 0,
    pid: 4242,
    build: 'atc/3.1.1+abc',
    listenPort: 8500,
    restored: 2,
    total: 2,
    failed: [],
    interrupted: [{ name: 'api', id: 's-1' }],
    error: null,
  });

  expect(lines).toStrictEqual([
    'daemon pid 4242, build atc/3.1.1+abc',
    'listening on port 8500',
    'restored 2 of 2',
    'interrupted 1 mid-turn:',
    '  api (s-1)',
    'restart succeeded',
  ]);
});

test('it names each failed row with its reason and ends on the exit code', () => {
  const lines = formatRestartReport({
    runID: 'r1',
    code: 1,
    pid: 4242,
    build: 'atc/3.1.1+abc',
    listenPort: null,
    restored: 1,
    total: 2,
    failed: [{ name: 'locked', id: 's-locked', reason: 'not listed after the restore' }],
    interrupted: [],
    error: null,
  });

  expect(lines).toStrictEqual([
    'daemon pid 4242, build atc/3.1.1+abc',
    'restored 1 of 2',
    'failed: locked (s-locked): not listed after the restore',
    'restart failed with exit code 1',
  ]);
});

test('it reports the error of a restart that stopped before it counted the fleet', () => {
  const lines = formatRestartReport({
    runID: 'r1',
    code: 1,
    pid: null,
    build: null,
    listenPort: null,
    restored: 0,
    total: 0,
    failed: [],
    interrupted: [],
    error: 'no replacement daemon answered within 30 s',
  });

  expect(lines).toStrictEqual([
    'restart failed: no replacement daemon answered within 30 s',
    'restart failed with exit code 1',
  ]);
});
