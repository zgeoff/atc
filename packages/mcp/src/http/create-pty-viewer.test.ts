import { expect, mock, test } from 'bun:test';
import { buildMockSessionDescriptor, waitFor } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { createPTYViewer } from './create-pty-viewer';
import type { PTYSocket, WatchChannel } from './create-pty-viewer';

function setupTest() {
  const sendRequest = mock<WatchChannel['sendRequest']>();

  const channel: WatchChannel = {
    onEvent: () => {},
    onClose: () => {},
    sendRequest,
    stop: mock<WatchChannel['stop']>(),
  };

  const socket = {
    send: mock<PTYSocket['send']>(),
    getBufferedAmount: mock(() => 0),
    close: mock<PTYSocket['close']>(),
  };

  return { channel, sendRequest, socket };
}

test('it sends the first snapshot, then the output above its sequence as binary frames', () => {
  const ctx = setupTest();

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 4, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 4, data: 'already shown' });
  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 5, data: 'next' });
  viewer.open(ctx.socket);
  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 6, data: 'live' });
  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-2', seq: 7, data: 'elsewhere' });

  expect(ctx.socket.send.mock.calls).toStrictEqual([
    [
      JSON.stringify({
        type: 'snapshot',
        cols: 80,
        rows: 24,
        seq: 4,
        state: 'running',
        data: 'screen',
      }),
    ],
    [new TextEncoder().encode('next')],
    [new TextEncoder().encode('live')],
  ]);
});

test('it takes a fresh snapshot when the output skips a sequence number', async () => {
  const ctx = setupTest();

  ctx.sendRequest.mockResolvedValue({ cols: 80, rows: 24, seq: 9, replay: 'repainted' });

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 1, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);
  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 3, data: 'after a gap' });

  await waitFor(() => {
    expect(ctx.socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'snapshot',
        cols: 80,
        rows: 24,
        seq: 9,
        state: 'running',
        data: 'repainted',
      }),
    );
  });

  expect(ctx.sendRequest).toHaveBeenCalledExactlyOnceWith('session.watch', { session: 's-1' });
});

test('it drops output while the socket holds too much, and takes a fresh snapshot once it drains', async () => {
  const ctx = setupTest();

  ctx.sendRequest.mockResolvedValue({ cols: 80, rows: 24, seq: 3, replay: 'caught up' });

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);
  ctx.socket.getBufferedAmount.mockReturnValue(4096);
  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 1, data: 'dropped' });
  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 2, data: 'dropped too' });
  ctx.socket.getBufferedAmount.mockReturnValue(0);
  viewer.drain();

  await waitFor(() => {
    expect(ctx.socket.send).toHaveBeenCalledTimes(2);
  });

  expect(ctx.socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({
      type: 'snapshot',
      cols: 80,
      rows: 24,
      seq: 3,
      state: 'running',
      data: 'caught up',
    }),
  );
});

test('it takes a fresh snapshot when the daemon reports dropped output', async () => {
  const ctx = setupTest();

  ctx.sendRequest.mockResolvedValue({ cols: 80, rows: 24, seq: 5, replay: 'repainted' });

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);
  ctx.channel.onEvent({ ev: 'SessionDesync', sessionID: 's-1', dropped: 2048 });

  await waitFor(() => {
    expect(ctx.socket.send).toHaveBeenCalledTimes(2);
  });

  expect(ctx.sendRequest).toHaveBeenCalledExactlyOnceWith('session.watch', { session: 's-1' });
});

test('it takes a fresh snapshot once the socket opens when the output held for it overflowed', async () => {
  const ctx = setupTest();

  ctx.sendRequest.mockResolvedValue({ cols: 80, rows: 24, seq: 1, replay: 'caught up' });

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 4,
  });

  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 1, data: 'past the limit' });
  viewer.open(ctx.socket);

  await waitFor(() => {
    expect(ctx.socket.send).toHaveBeenCalledTimes(2);
  });

  expect(ctx.socket.send.mock.calls).toStrictEqual([
    [
      JSON.stringify({
        type: 'snapshot',
        cols: 80,
        rows: 24,
        seq: 0,
        state: 'running',
        data: 'screen',
      }),
    ],
    [
      JSON.stringify({
        type: 'snapshot',
        cols: 80,
        rows: 24,
        seq: 1,
        state: 'running',
        data: 'caught up',
      }),
    ],
  ]);
});

test('it sends a resize that arrived while a snapshot was on its way after that snapshot', async () => {
  const ctx = setupTest();
  const reply = Promise.withResolvers<Readonly<Record<string, unknown>>>();

  ctx.sendRequest.mockReturnValue(reply.promise);

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);
  ctx.channel.onEvent({ ev: 'SessionDesync', sessionID: 's-1', dropped: 64 });
  ctx.channel.onEvent({ ev: 'SessionResized', sessionID: 's-1', cols: 100, rows: 30 });
  reply.resolve({ cols: 80, rows: 24, seq: 1, replay: 'before the resize' });

  await waitFor(() => {
    expect(ctx.socket.send).toHaveBeenCalledTimes(3);
  });

  expect(ctx.socket.send.mock.calls.slice(1)).toStrictEqual([
    [
      JSON.stringify({
        type: 'snapshot',
        cols: 80,
        rows: 24,
        seq: 1,
        state: 'running',
        data: 'before the resize',
      }),
    ],
    [JSON.stringify({ type: 'resize', cols: 100, rows: 30 })],
  ]);
});

test('it sends the new size and state of the session as control frames', () => {
  const ctx = setupTest();

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);
  ctx.channel.onEvent({ ev: 'SessionResized', sessionID: 's-1', cols: 100, rows: 30 });

  ctx.channel.onEvent({
    ev: 'SessionState',
    session: buildMockSessionDescriptor({ id: toSessionID('s-1'), state: 'needs_you' }),
  });

  expect(ctx.socket.send.mock.calls.slice(1)).toStrictEqual([
    [JSON.stringify({ type: 'resize', cols: 100, rows: 30 })],
    [JSON.stringify({ type: 'state', state: 'needs_you' })],
  ]);
});

test('it closes the socket with the reason once the session exits', () => {
  const ctx = setupTest();

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);

  ctx.channel.onEvent({
    ev: 'SessionState',
    session: buildMockSessionDescriptor({ id: toSessionID('s-1'), state: 'exited' }),
  });

  expect(ctx.socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: 'closed', reason: 'exited' }),
  );

  expect(ctx.socket.close).toHaveBeenCalledExactlyOnceWith(1000, 'exited');
  expect(ctx.channel.stop).toHaveBeenCalledOnce();
});

test('it tells a socket that opens after the session was removed why it closed', () => {
  const ctx = setupTest();

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  ctx.channel.onEvent({ ev: 'SessionRemoved', sessionID: 's-1' });
  viewer.open(ctx.socket);

  expect(ctx.socket.send.mock.calls).toStrictEqual([
    [JSON.stringify({ type: 'closed', reason: 'removed' })],
  ]);

  expect(ctx.socket.close).toHaveBeenCalledExactlyOnceWith(1000, 'removed');
});

test('it closes the socket once its daemon connection ends', () => {
  const ctx = setupTest();

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);
  ctx.channel.onClose();

  expect(ctx.socket.close).toHaveBeenCalledExactlyOnceWith(1000, 'daemon_closed');
});

test('it ends its daemon connection once the browser closes the socket', () => {
  const ctx = setupTest();

  const viewer = createPTYViewer({
    sessionID: 's-1',
    channel: ctx.channel,
    first: { cols: 80, rows: 24, seq: 0, replay: 'screen', state: 'running' },
    maxBufferedBytes: 1024,
  });

  viewer.open(ctx.socket);
  viewer.close();
  ctx.channel.onEvent({ ev: 'SessionOutput', sessionID: 's-1', seq: 1, data: 'late' });

  expect(ctx.channel.stop).toHaveBeenCalledOnce();
  expect(ctx.socket.send).toHaveBeenCalledOnce();
});
