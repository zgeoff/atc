import { expect, test } from 'bun:test';
import { RefusalLog } from './refusal-log';

test('it logs the first refusal of a window at once with a count of one', () => {
  const logged: string[] = [];

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => 0,
    intervalMs: 60_000,
    maxWindows: 16,
  });

  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs no line for a repeated refusal within the window', () => {
  const logged: string[] = [];
  let clock = 0;

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => clock,
    intervalMs: 60_000,
    maxWindows: 16,
  });

  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });

  clock += 59_999;

  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs the count of an ended window on the next refusal from another peer', () => {
  const logged: string[] = [];
  let clock = 0;

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => clock,
    intervalMs: 60_000,
    maxWindows: 16,
  });

  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });

  clock += 60_000;

  log.record({ event: 'principal_refused', peer: '10.0.0.2' });

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=2',
    'atc tcp event=principal_refused peer=10.0.0.2 principal=unlisted count=1',
  ]);
});

test('it keeps separate windows for each reason from one peer', () => {
  const logged: string[] = [];

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => 0,
    intervalMs: 60_000,
    maxWindows: 16,
  });

  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'missing_token' });

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=missing_token count=1',
  ]);
});

test('it folds refusals of different principals from one peer within the window into one line', () => {
  const logged: string[] = [];
  let clock = 0;

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => clock,
    intervalMs: 60_000,
    maxWindows: 16,
  });

  log.record({ event: 'principal_refused', peer: '10.0.0.1' });
  log.record({ event: 'principal_refused', peer: '10.0.0.1' });
  log.record({ event: 'principal_refused', peer: '10.0.0.1' });

  clock += 60_000;

  log.record({ event: 'principal_refused', peer: '10.0.0.1' });

  expect(logged).toStrictEqual([
    'atc tcp event=principal_refused peer=10.0.0.1 principal=unlisted count=1',
    'atc tcp event=principal_refused peer=10.0.0.1 principal=unlisted count=2',
    'atc tcp event=principal_refused peer=10.0.0.1 principal=unlisted count=1',
  ]);
});

test('it starts a window for each new peer while the cap of windows has room', () => {
  const logged: string[] = [];

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => 0,
    intervalMs: 60_000,
    maxWindows: 3,
  });

  for (const peer of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    log.record({ event: 'handshake_refused', peer, reason: 'unauthorized' });
  }

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.2 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.3 reason=unauthorized count=1',
  ]);
});

test('it folds every peer past the cap of windows into one overflow window', () => {
  const logged: string[] = [];

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => 0,
    intervalMs: 60_000,
    maxWindows: 2,
  });

  for (const peer of Array.from({ length: 5 }, () => [
    '10.0.0.1',
    '10.0.0.2',
    '10.0.0.3',
    '10.0.0.4',
  ]).flat()) {
    log.record({ event: 'handshake_refused', peer, reason: 'unauthorized' });
  }

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=10.0.0.2 reason=unauthorized count=1',
    'atc tcp event=refused peer=overflow count=1',
  ]);
});

test('it logs the count of the overflow window once it ends', () => {
  const logged: string[] = [];
  let clock = 0;

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => clock,
    intervalMs: 60_000,
    maxWindows: 1,
  });

  for (const peer of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
    log.record({ event: 'handshake_refused', peer, reason: 'unauthorized' });
  }

  clock += 60_000;

  log.record({ event: 'handshake_refused', peer: '10.0.0.5', reason: 'unauthorized' });

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=refused peer=overflow count=1',
    'atc tcp event=refused peer=overflow count=2',
    'atc tcp event=handshake_refused peer=10.0.0.5 reason=unauthorized count=1',
  ]);
});

test('it logs every pending count on a drain', () => {
  const logged: string[] = [];

  const log = new RefusalLog({
    log: (line) => {
      logged.push(line);
    },
    now: () => 0,
    intervalMs: 60_000,
    maxWindows: 16,
  });

  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  log.record({ event: 'handshake_refused', peer: '10.0.0.1', reason: 'unauthorized' });
  log.record({ event: 'principal_refused', peer: '10.0.0.2' });
  log.drain();

  expect(logged).toStrictEqual([
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
    'atc tcp event=principal_refused peer=10.0.0.2 principal=unlisted count=1',
    'atc tcp event=handshake_refused peer=10.0.0.1 reason=unauthorized count=1',
  ]);
});
