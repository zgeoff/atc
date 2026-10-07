import { expect, test } from 'bun:test';
import { buildStubPeerSocket } from './build-stub-peer-socket';

test('it takes every byte of a write while accepting', () => {
  const peer = buildStubPeerSocket();

  expect(peer.write(new TextEncoder().encode('one\n'))).toBe(4);
});

test('it takes no byte of a write while not accepting', () => {
  const peer = buildStubPeerSocket();

  peer.setAccepting(false);

  expect(peer.write(new TextEncoder().encode('one\n'))).toBe(0);
});

test('it collects the complete lines taken, in order, and none it refused', () => {
  const peer = buildStubPeerSocket();

  const encoder = new TextEncoder();

  peer.write(encoder.encode('one\n'));
  peer.setAccepting(false);
  peer.write(encoder.encode('dropped\n'));
  peer.setAccepting(true);
  peer.write(encoder.encode('two\nthr'));

  expect(peer.collectWrittenLines()).toStrictEqual(['one', 'two', 'thr']);
});
