import { expect, test } from 'bun:test';
import { HandshakeThrottle } from './handshake-throttle';

test('it delays the handshake after five failures within a minute', () => {
  const throttle = new HandshakeThrottle(10_000);

  for (const at of [0, 1000, 2000, 3000, 4000]) {
    throttle.recordFailure('10.42.0.7', at);
  }

  expect(throttle.getDelay('10.42.0.7', 5000)).toBe(10_000);
});

test('it does not delay the handshake after four failures', () => {
  const throttle = new HandshakeThrottle(10_000);

  for (const at of [0, 1000, 2000, 3000]) {
    throttle.recordFailure('10.42.0.7', at);
  }

  expect(throttle.getDelay('10.42.0.7', 5000)).toBe(0);
});

test('it stops delaying once the failures are older than a minute', () => {
  const throttle = new HandshakeThrottle(10_000);

  for (const at of [0, 1000, 2000, 3000, 4000]) {
    throttle.recordFailure('10.42.0.7', at);
  }

  expect(throttle.getDelay('10.42.0.7', 60_500)).toBe(0);
});

test('it keeps the failures of one address from delaying another', () => {
  const throttle = new HandshakeThrottle(10_000);

  for (const at of [0, 1000, 2000, 3000, 4000]) {
    throttle.recordFailure('10.42.0.7', at);
  }

  expect(throttle.getDelay('10.42.0.8', 5000)).toBe(0);
});

test('it keeps delaying an address that failed far more than five times', () => {
  const throttle = new HandshakeThrottle(10_000);

  for (let at = 0; at < 100_000; at++) {
    throttle.recordFailure('10.42.0.7', at / 10);
  }

  expect(throttle.getDelay('10.42.0.7', 10_000)).toBe(10_000);
});
