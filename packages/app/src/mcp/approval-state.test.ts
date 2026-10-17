import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { ApprovalState } from './approval-state';

test('it gives each pending request a random correlation id unrelated to its key', () => {
  const state = new ApprovalState(600_000, () => 1000);

  const first = state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  const second = state.createPending({
    key: 'q2',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  invariant(first !== null && second !== null, 'an approval was refused');

  expect(first.correlationID).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

  expect(second.correlationID).not.toBe(first.correlationID);
});

test("it takes a request's challenge once", () => {
  const state = new ApprovalState(600_000, () => 1000);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  const challenge = state.mintChallenge('q1');

  invariant(challenge !== null, 'the request no longer waits');

  const taken = [state.claimChallenge('q1'), state.claimChallenge('q1')];

  expect(taken).toStrictEqual([{ kind: 'taken', challenge }, { kind: 'missing' }]);
});

test('it mints a fresh 32-byte challenge for each login page and keeps only the last', () => {
  const state = new ApprovalState(600_000, () => 1000);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  const first = state.mintChallenge('q1');
  const second = state.mintChallenge('q1');

  invariant(first !== null && second !== null, 'the request no longer waits');

  expect(Buffer.from(second, 'base64url')).toHaveLength(32);
  expect(second).not.toBe(first);
  expect(state.claimChallenge('q1')).toStrictEqual({ kind: 'taken', challenge: second });
});

test('it reports a challenge taken after five minutes as expired', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  state.mintChallenge('q1');

  now = 1000 + 300_000;

  expect(state.claimChallenge('q1')).toStrictEqual({ kind: 'expired' });
});

test('it keeps the challenges of two requests apart', () => {
  const state = new ApprovalState(600_000, () => 1000);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  state.createPending({
    key: 'q2',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  state.mintChallenge('q1');

  expect(state.claimChallenge('q2')).toStrictEqual({ kind: 'missing' });
});

test('it mints no challenge for a request that does not wait', () => {
  const state = new ApprovalState(600_000, () => 1000);

  expect(state.mintChallenge('q1')).toBeNull();
});

test('it locks a pending request on the fifth failed sign-in', () => {
  const state = new ApprovalState(600_000, () => 1000);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  const results = [1, 2, 3, 4, 5].map(() => state.recordFailure('q1'));

  expect(results).toStrictEqual(['retry', 'retry', 'retry', 'retry', 'locked']);
  expect(state.findPending('q1')).toBeNull();
});

test('it removes a pending request with its challenge', () => {
  const state = new ApprovalState(600_000, () => 1000);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  state.mintChallenge('q1');
  state.removePending('q1');

  expect(state.claimChallenge('q1')).toStrictEqual({ kind: 'missing' });
});

test('it forgets a pending request once it expires', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  now = 601_000;

  expect(state.findPending('q1')).toBeNull();
});

test("it drops a client's oldest waiting approval when it starts a fourth", () => {
  const state = new ApprovalState(600_000, () => 1000);

  const created = ['q1', 'q2', 'q3', 'q4'].map((key) =>
    state.createPending({
      key,
      clientID: 'c1',
      clientName: 'dots',
      redirectURI: 'https://dots.example/cb',
    }),
  );

  const found = ['q1', 'q2', 'q3', 'q4'].map((key) => state.findPending(key));

  expect(found).toStrictEqual(created.with(0, null));
});

test('it drops the oldest waiting approval to make room for a seventeenth', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  const created = Array.from({ length: 17 }, (_, index) => {
    now = 1000 + index * 7000;

    return state.createPending({
      key: `q${index}`,
      clientID: `c${index}`,
      clientName: `c${index}`,
      redirectURI: 'https://dots.example/cb',
    });
  });

  const found = Array.from({ length: 17 }, (_, index) => state.findPending(`q${index}`));

  expect(found).toStrictEqual(created.with(0, null));
});

test('it refuses an eleventh approval started within a minute', () => {
  const state = new ApprovalState(600_000, () => 1000);

  const created = Array.from({ length: 11 }, (_, index) =>
    state.createPending({
      key: `q${index}`,
      clientID: `c${index}`,
      clientName: `c${index}`,
      redirectURI: 'https://dots.example/cb',
    }),
  );

  expect(created.slice(0, 10)).toSatisfyAll((approval) => approval !== null);
  expect(created[10]).toBeNull();
});

test('it starts approvals again a minute after the limit was reached', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  Array.from({ length: 10 }, (_, index) =>
    state.createPending({
      key: `q${index}`,
      clientID: `c${index}`,
      clientName: `c${index}`,
      redirectURI: 'https://dots.example/cb',
    }),
  );

  now = 1000 + 60_000;

  expect(
    state.createPending({
      key: 'q10',
      clientID: 'c10',
      clientName: 'c10',
      redirectURI: 'https://dots.example/cb',
    }),
  ).not.toBeNull();
});

test('it holds the binding and correlation id an owner session approved', () => {
  const state = new ApprovalState(600_000, () => 1000);

  state.recordApproved('session-1', { binding: 'binding-1', correlationID: 'corr-1' });

  expect(state.findApproved('session-1')).toStrictEqual({
    binding: 'binding-1',
    correlationID: 'corr-1',
    expiresAt: 601_000,
  });
});

test('it holds no binding for an owner session other than the one that approved', () => {
  const state = new ApprovalState(600_000, () => 1000);

  state.recordApproved('session-1', { binding: 'binding-1', correlationID: 'corr-1' });

  expect(state.findApproved('session-2')).toBeNull();
});

test('it forgets an approved binding once it expires', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  state.recordApproved('session-1', { binding: 'binding-1', correlationID: 'corr-1' });

  now = 601_000;

  expect(state.findApproved('session-1')).toBeNull();
});
