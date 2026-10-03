import { expect, test } from 'bun:test';
import { RefusalLog } from './refusal-log';

function setupTest(maxWindows: number) {
  const logged: string[] = [];
  let clock = 0;

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => clock,
    intervalMs: 60_000,
    maxWindows,
  });

  return {
    log,
    logged,
    advanceClock(ms: number): void {
      clock += ms;
    },
  };
}

test('it logs the first refusal of a window at once with a count of one', () => {
  const refusals = setupTest(16);

  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs no line for a repeated refusal within the window', () => {
  const refusals = setupTest(16);

  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.advanceClock(59_999);
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs the count of an ended window on the next refusal from another peer', () => {
  const refusals = setupTest(16);

  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.advanceClock(60_000);
  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.2' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=2',
    'atc tcp event=principal_refused peer=10.0.0.2 principal=unlisted count=1',
  ]);
});

test('it keeps separate windows for each reason from one peer', () => {
  const refusals = setupTest(16);

  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'missing_token' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=missing_token count=1',
  ]);
});

test('it folds refusals of different principals from one peer within the window into one line', () => {
  const refusals = setupTest(16);

  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.1' });
  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.1' });
  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.1' });
  refusals.advanceClock(60_000);
  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.1' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=principal_refused peer=10.0.0.1 principal=unlisted count=1',
    'atc tcp event=principal_refused peer=10.0.0.1 principal=unlisted count=2',
    'atc tcp event=principal_refused peer=10.0.0.1 principal=unlisted count=1',
  ]);
});

test('it starts a window for each new peer while the cap of windows has room', () => {
  const refusals = setupTest(3);

  for (const peer of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    refusals.log.record({ event: 'handshake_refused', peer, reason: 'unauthorized' });
  }

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.2 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.3 reason=unauthorized count=1',
  ]);
});

test('it folds every peer past the cap of windows into one overflow window', () => {
  const refusals = setupTest(2);

  for (const peer of Array.from({ length: 5 }, () => [
    '10.0.0.1',
    '10.0.0.2',
    '10.0.0.3',
    '10.0.0.4',
  ]).flat()) {
    refusals.log.record({ event: 'handshake_refused', peer, reason: 'unauthorized' });
  }

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.2 reason=unauthorized count=1',
    'atc tcp event=refused peer=overflow count=1',
  ]);
});

test('it logs the count of the overflow window once it ends', () => {
  const refusals = setupTest(1);

  for (const peer of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
    refusals.log.record({ event: 'handshake_refused', peer, reason: 'unauthorized' });
  }

  refusals.advanceClock(60_000);
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.5', reason: 'unauthorized' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=refused peer=overflow count=1',
    'atc tcp event=refused peer=overflow count=2',
    'atc tcp event=handshake_refused peer=10.0.0.5 reason=unauthorized count=1',
  ]);
});

test('it logs every pending count on a drain', () => {
  const refusals = setupTest(16);

  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.2' });
  refusals.log.drain();

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=principal_refused peer=10.0.0.2 principal=unlisted count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});
