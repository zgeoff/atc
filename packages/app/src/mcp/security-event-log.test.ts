import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/test-utils';
import { SecurityEventLog } from './security-event-log';

// A log on a clock that moves only when the test advances it, with every
// line it prints collected.
function setupTest() {
  const clock = buildStubClock(Date.UTC(2026, 9, 14, 12, 0, 0));
  const lines: string[] = [];

  const log = new SecurityEventLog({
    print: (line) => {
      lines.push(line);
    },
    clock,
  });

  return { clock, lines, log };
}

test('it prints each event as an atc security line', () => {
  const ctx = setupTest();

  ctx.log.record({
    kind: 'authorize_invalid',
    outcome: 'rejected',
    reason: 'bad_host',
    path: '/mcp',
    requester: { socketAddress: '127.0.0.1', connectingIP: null, userAgent: null },
  });

  expect(ctx.lines).toStrictEqual([
    'atc security {"v":1,"ts":"2026-10-14T12:00:00.000Z","kind":"authorize_invalid","outcome":"rejected","reason":"bad_host","route":"/mcp","peer":{"address":"127.0.0.1","provenance":"socket"}}',
  ]);
});

test('it prints one suppressed event with the count once a burst past the cap ends its window', () => {
  const ctx = setupTest();

  for (let index = 0; index < 27; index++) {
    ctx.log.record({
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_host',
      path: '/mcp',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    });
  }

  ctx.clock.advance(60_000);

  expect(ctx.lines).toBeArrayOfSize(21);
  expect(ctx.lines.slice(0, 20)).toSatisfyAll((line: string) => line.includes('"bad_host"'));

  expect(ctx.lines[20]).toBe(
    'atc security {"v":1,"ts":"2026-10-14T12:01:00.000Z","kind":"suppressed","reason":"authorize_invalid","count":7}',
  );
});

test('it prints no suppressed event for a window that dropped nothing', () => {
  const ctx = setupTest();

  for (let index = 0; index < 20; index++) {
    ctx.log.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'assertion_failed',
      path: '/login',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    });
  }

  ctx.clock.advance(120_000);
  ctx.log.drain();

  expect(ctx.lines).toBeArrayOfSize(20);
  expect(ctx.lines.join('\n')).not.toInclude('suppressed');
});

test('it caps each kind on its own', () => {
  const ctx = setupTest();

  for (let index = 0; index < 25; index++) {
    ctx.log.record({
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_host',
      path: '/mcp',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    });
  }

  ctx.log.record({
    kind: 'owner_auth',
    outcome: 'failed',
    reason: 'expired',
    path: '/login',
    requester: { socketAddress: null, connectingIP: null, userAgent: null },
  });

  expect(ctx.lines).toBeArrayOfSize(21);
  expect(ctx.lines[20]).toInclude('"kind":"owner_auth"');
});

test('it prints events of a kind again once its window ends', () => {
  const ctx = setupTest();

  for (let index = 0; index < 21; index++) {
    ctx.log.record({
      kind: 'consent',
      outcome: 'denied',
      path: '/consent',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    });
  }

  ctx.clock.advance(60_000);

  ctx.log.record({
    kind: 'consent',
    outcome: 'allowed',
    path: '/consent',
    requester: { socketAddress: null, connectingIP: null, userAgent: null },
  });

  expect(ctx.lines.slice(20)).toStrictEqual([
    'atc security {"v":1,"ts":"2026-10-14T12:01:00.000Z","kind":"suppressed","reason":"consent","count":1}',
    'atc security {"v":1,"ts":"2026-10-14T12:01:00.000Z","kind":"consent","outcome":"allowed","route":"/consent"}',
  ]);
});

test('it prints the pending suppressed count when drained before the window ends', () => {
  const ctx = setupTest();

  for (let index = 0; index < 23; index++) {
    ctx.log.record({
      kind: 'authorize_started',
      outcome: 'rejected',
      reason: 'rate_limited',
      path: '/oauth2/authorize',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    });
  }

  ctx.clock.advance(1000);
  ctx.log.drain();
  ctx.clock.advance(60_000);

  expect(ctx.lines.slice(20)).toStrictEqual([
    'atc security {"v":1,"ts":"2026-10-14T12:00:01.000Z","kind":"suppressed","reason":"authorize_started","count":3}',
  ]);
});
