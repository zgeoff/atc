import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { buildStubClock } from '@atc/test-utils';
import { createConfirmTokens } from './create-confirm-tokens';

// The tokens on a clock the test steps, each usable for a minute.
function setupTest() {
  const clock = buildStubClock(1_000_000);
  const tokens = createConfirmTokens({ now: () => clock.now(), lifetimeMs: 60_000 });

  return { clock, tokens };
}

test('it mints a token that stays usable for its lifetime', () => {
  const ctx = setupTest();
  const minted = ctx.tokens.mintToken(toSessionID('s-1'));

  expect(minted.expiresAt).toBe(1_060_000);
  expect(minted.confirmToken).not.toBeEmpty();
});

test('it takes a token for its own session up to the last millisecond of its lifetime', () => {
  const ctx = setupTest();
  const minted = ctx.tokens.mintToken(toSessionID('s-1'));

  ctx.clock.advance(59_999);

  expect(() => {
    ctx.tokens.claimToken(toSessionID('s-1'), minted.confirmToken);
  }).not.toThrow();
});

test('it refuses a token a claim already took', () => {
  const ctx = setupTest();
  const minted = ctx.tokens.mintToken(toSessionID('s-1'));

  ctx.tokens.claimToken(toSessionID('s-1'), minted.confirmToken);

  expect(() => {
    ctx.tokens.claimToken(toSessionID('s-1'), minted.confirmToken);
  }).toThrowWithMessage(DaemonError, /^confirm token for session s-1 is used;/u);
});

test('it refuses a token past its lifetime as expired', () => {
  const ctx = setupTest();
  const minted = ctx.tokens.mintToken(toSessionID('s-1'));

  ctx.clock.advance(60_000);

  expect(() => {
    ctx.tokens.claimToken(toSessionID('s-1'), minted.confirmToken);
  }).toThrowWithMessage(DaemonError, /^confirm token for session s-1 is expired;/u);
});

test('it forgets a token one lifetime after it expired', () => {
  const ctx = setupTest();
  const minted = ctx.tokens.mintToken(toSessionID('s-1'));

  ctx.clock.advance(120_001);

  expect(() => {
    ctx.tokens.claimToken(toSessionID('s-1'), minted.confirmToken);
  }).toThrowWithMessage(DaemonError, /^confirm token for session s-1 is unknown;/u);
});

test('it refuses a token minted for another session', () => {
  const ctx = setupTest();
  const minted = ctx.tokens.mintToken(toSessionID('s-1'));

  expect(() => {
    ctx.tokens.claimToken(toSessionID('s-2'), minted.confirmToken);
  }).toThrowWithMessage(DaemonError, /^confirm token for session s-2 is unknown;/u);
});

test('it refuses a token it never minted', () => {
  const ctx = setupTest();

  expect(() => {
    ctx.tokens.claimToken(toSessionID('s-1'), 'made-up-token');
  }).toThrowWithMessage(DaemonError, /^confirm token for session s-1 is unknown;/u);
});
