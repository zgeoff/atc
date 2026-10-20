import { expect, test } from 'bun:test';
import { buildStubPeerSocket } from './build-stub-peer-socket';

test('it takes every byte it is given at once', () => {
  const stub = buildStubPeerSocket();

  expect(stub.socket.write(new TextEncoder().encode('{"i":"1","p":{}}\n'))).toBe(17);
});

test('it collects each complete line written as one decoded frame, in order', () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(new TextEncoder().encode('{"i":"1","p":{"b":{"json":{}}}}\n{"i":"2",'));
  stub.socket.write(new TextEncoder().encode('"p":{"s":400,"b":{"json":{"code":"bad_args"}}}}\n'));

  expect(stub.collectFrames()).toStrictEqual([
    { kind: 'response', id: '1', status: 200, headers: {}, body: {} },
    { kind: 'response', id: '2', status: 400, headers: {}, body: { code: 'bad_args' } },
  ]);
});

test('it leaves out a line the daemon has not finished writing', () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(new TextEncoder().encode('{"i":"1","p":{"b":{"json":{}}}}\n{"i":"2",'));

  expect(stub.collectFrames()).toStrictEqual([
    { kind: 'response', id: '1', status: 200, headers: {}, body: {} },
  ]);
});

test('it refuses a line that is not a peer frame', () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(new TextEncoder().encode('[1]\n'));

  expect(() => stub.collectFrames()).toThrowWithMessage(
    TypeError,
    'a peer frame is a JSON object with a string id, not [1]',
  );
});

test('it answers a wait for a message already written with its decoded frame', async () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(
    new TextEncoder().encode(
      '{"i":"1","p":{"b":{"json":{}}}}\n{"i":"2","p":{"b":{"json":{"count":2}}}}\n',
    ),
  );

  const answer = await stub.waitForAnswer('2');

  expect(answer).toStrictEqual({ status: 200, headers: {}, body: { count: 2 } });
});

test('it answers a wait for a message once a later write completes it', async () => {
  const stub = buildStubPeerSocket();
  const answer = stub.waitForAnswer('1');

  stub.socket.write(new TextEncoder().encode('{"i":"1",'));
  stub.socket.write(new TextEncoder().encode('"p":{"s":400,"b":{"json":{"code":"bad_args"}}}}\n'));

  const answered = await answer;

  expect(answered).toStrictEqual({ status: 400, headers: {}, body: { code: 'bad_args' } });
});

test('it fails a wait whose message ends a stream, not a response', async () => {
  const stub = buildStubPeerSocket();
  const answer = stub.waitForAnswer('1');

  stub.socket.write(new TextEncoder().encode('{"i":"1","t":4}\n'));

  await expect(answer).rejects.toThrowWithMessage(
    TypeError,
    'message 1 is an abort, not a response',
  );
});

test('it leaves a wait pending while only other messages are written', async () => {
  const stub = buildStubPeerSocket();
  const answer = stub.waitForAnswer('2');

  stub.socket.write(new TextEncoder().encode('{"i":"1","p":{"b":{"json":{}}}}\n'));

  const raced = await Promise.race([answer, Promise.resolve('pending')]);

  expect(raced).toBe('pending');
});

test('it records that the daemon ended the connection', () => {
  const stub = buildStubPeerSocket();

  stub.socket.end();

  expect(stub.hasEnded()).toBeTrue();
});

test('it reports a connection the daemon never ended as open', () => {
  const stub = buildStubPeerSocket();

  expect(stub.hasEnded()).toBeFalse();
});

test('it takes no byte of a write while not accepting', () => {
  const stub = buildStubPeerSocket();

  stub.setAccepting(false);

  expect(stub.socket.write(new TextEncoder().encode('{"i":"1","p":{}}\n'))).toBe(0);
});

test('it collects no frame from a write it refused, and every frame once it accepts again', () => {
  const stub = buildStubPeerSocket();

  const encoder = new TextEncoder();

  stub.socket.write(encoder.encode('{"i":"1","t":4}\n'));
  stub.setAccepting(false);
  stub.socket.write(encoder.encode('{"i":"2","t":4}\n'));
  stub.setAccepting(true);
  stub.socket.write(encoder.encode('{"i":"3","t":4}\n'));

  expect(stub.collectFrames()).toStrictEqual([
    { kind: 'abort', id: '1' },
    { kind: 'abort', id: '3' },
  ]);
});

test('it counts each write it refused, and none it took', () => {
  const stub = buildStubPeerSocket();

  const encoder = new TextEncoder();

  stub.socket.write(encoder.encode('{"i":"1","t":4}\n'));
  stub.setAccepting(false);
  stub.socket.write(encoder.encode('{"i":"2","t":4}\n'));
  stub.socket.write(encoder.encode('{"i":"3","t":4}\n'));

  expect(stub.countRefusedWrites()).toBe(2);
});
