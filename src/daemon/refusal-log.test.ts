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
  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.2', principal: 'ops' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=2',
    'atc tcp event=principal_refused peer=10.0.0.2 principal=ops count=1',
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

test('it ends the oldest window early, with its count, once the cap of windows is full', () => {
  const refusals = setupTest(2);

  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.2', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.3', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.2 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.3 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs every pending count on a drain', () => {
  const refusals = setupTest(16);

  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  refusals.log.record({ event: 'principal_refused', peer: '10.0.0.2', principal: 'ops' });
  refusals.log.drain();

  expect(refusals.logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=principal_refused peer=10.0.0.2 principal=ops count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});
