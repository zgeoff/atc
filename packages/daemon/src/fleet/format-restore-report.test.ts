import { expect, test } from 'bun:test';
import { formatRestoreReport } from './format-restore-report';

test('it reports each lane with its terminals, starts, and the time to its last start', () => {
  expect(
    formatRestoreReport(7, [
      { lane: 'local', terminals: 4, attached: 0, started: 4, lastStartMs: 12_345 },
      { lane: 'remote', terminals: 2, attached: 1, started: 1, lastStartMs: 40_060 },
    ]),
  ).toBe(
    'atc restored the fleet (registered 7; local: terminals 4, attached 0, started 4, last start 12.3s; remote: terminals 2, attached 1, started 1, last start 40.1s)',
  );
});

test('it reports a lane where no agent reported a start', () => {
  expect(
    formatRestoreReport(1, [
      { lane: 'remote', terminals: 1, attached: 1, started: 0, lastStartMs: null },
    ]),
  ).toBe(
    'atc restored the fleet (registered 1; remote: terminals 1, attached 1, started 0, last start none)',
  );
});
