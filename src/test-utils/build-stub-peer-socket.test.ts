import { expect, test } from 'bun:test';
import { buildStubPeerSocket } from './build-stub-peer-socket';

test('it takes every byte it is given at once', () => {
  const stub = buildStubPeerSocket();

  expect(stub.socket.write(new TextEncoder().encode('{"id":1}\n'))).toBe(9);
});

test('it collects each complete line written as one frame, in order', () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(new TextEncoder().encode('{"id":1,"ok":{}}\n{"id":2,'));
  stub.socket.write(new TextEncoder().encode('"err":{"code":"bad_args"}}\n'));

  expect(stub.collectFrames()).toStrictEqual([
    { id: 1, ok: {} },
    { id: 2, err: { code: 'bad_args' } },
  ]);
});

test('it leaves out a line the daemon has not finished writing', () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(new TextEncoder().encode('{"id":1,"ok":{}}\n{"id":2,'));

  expect(stub.collectFrames()).toStrictEqual([{ id: 1, ok: {} }]);
});

test('it refuses a line that is not a JSON object as a frame', () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(new TextEncoder().encode('[1]\n'));

  expect(() => stub.collectFrames()).toThrowWithMessage(
    TypeError,
    'a protocol frame is a JSON object, not [1]',
  );
});

test('it answers a wait for a frame already written with that frame, its id left out', async () => {
  const stub = buildStubPeerSocket();

  stub.socket.write(new TextEncoder().encode('{"id":1,"ok":{}}\n{"id":2,"ok":{"n":2}}\n'));

  const answer = await stub.waitForAnswer(2);

  expect(answer).toStrictEqual({ ok: { n: 2 } });
});

test('it answers a wait for a frame once a later write completes it', async () => {
  const stub = buildStubPeerSocket();
  const answer = stub.waitForAnswer(1);

  stub.socket.write(new TextEncoder().encode('{"id":1,'));
  stub.socket.write(new TextEncoder().encode('"err":{"code":"bad_args"}}\n'));

  const answered = await answer;

  expect(answered).toStrictEqual({ err: { code: 'bad_args' } });
});

test('it leaves a wait pending while only other frames are written', async () => {
  const stub = buildStubPeerSocket();
  const answer = stub.waitForAnswer(2);

  stub.socket.write(new TextEncoder().encode('{"id":1,"ok":{}}\n'));

  const raced = await Promise.race([answer, Promise.resolve('pending')]);

  expect(raced).toBe('pending');
});

test('it takes no byte of a write while not accepting', () => {
  const stub = buildStubPeerSocket();

  stub.setAccepting(false);

  expect(stub.socket.write(new TextEncoder().encode('{"id":1}\n'))).toBe(0);
});

test('it collects no frame from a write it refused, and every frame once it accepts again', () => {
  const stub = buildStubPeerSocket();

  const encoder = new TextEncoder();

  stub.socket.write(encoder.encode('{"id":1}\n'));
  stub.setAccepting(false);
  stub.socket.write(encoder.encode('{"id":2}\n'));
  stub.setAccepting(true);
  stub.socket.write(encoder.encode('{"id":3}\n'));

  expect(stub.collectFrames()).toStrictEqual([{ id: 1 }, { id: 3 }]);
});
