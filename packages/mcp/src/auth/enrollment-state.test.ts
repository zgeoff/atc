import { expect, test } from 'bun:test';
import { EnrollmentState } from './enrollment-state';

test("it takes a token's challenge once", () => {
  const state = new EnrollmentState(() => 1000);

  const challenge = state.mintChallenge('hash-1');
  const taken = [state.claimChallenge('hash-1'), state.claimChallenge('hash-1')];

  expect(taken).toStrictEqual([{ kind: 'taken', challenge }, { kind: 'missing' }]);
});

test('it keeps only the last challenge minted for a token', () => {
  const state = new EnrollmentState(() => 1000);

  state.mintChallenge('hash-1');

  const second = state.mintChallenge('hash-1');

  expect(state.claimChallenge('hash-1')).toStrictEqual({ kind: 'taken', challenge: second });
});

test('it keeps the challenges of two tokens apart', () => {
  const state = new EnrollmentState(() => 1000);

  state.mintChallenge('hash-1');

  expect(state.claimChallenge('hash-2')).toStrictEqual({ kind: 'missing' });
});

test('it reports a challenge taken after five minutes as expired', () => {
  let now = 1000;

  const state = new EnrollmentState(() => now);

  state.mintChallenge('hash-1');

  now = 1000 + 300_000;

  expect(state.claimChallenge('hash-1')).toStrictEqual({ kind: 'expired' });
});

test('it drops the oldest challenge to make room for a ninth', () => {
  const state = new EnrollmentState(() => 1000);

  Array.from({ length: 9 }, (_, index) => state.mintChallenge(`hash-${index}`));

  expect(state.claimChallenge('hash-0')).toStrictEqual({ kind: 'missing' });
  expect(state.claimChallenge('hash-8').kind).toBe('taken');
});
