import { expect, test } from 'bun:test';
import { findBridgeSocket } from './find-bridge-socket';

test("it picks a remote session's bridge socket", () => {
  expect(
    findBridgeSocket({ sessionID: 's-1', socket: '/scratch/atc/run/s1.sock', bridge: true }),
  ).toBe('/scratch/atc/run/s1.sock');
});

test("it picks no socket for a local session, which boots the daemon's own", () => {
  expect(findBridgeSocket({ sessionID: 's-1', socket: '/state/atc/reporter.sock' })).toBeNull();
});

test('it picks no socket outside every session', () => {
  expect(findBridgeSocket({})).toBeNull();
});
