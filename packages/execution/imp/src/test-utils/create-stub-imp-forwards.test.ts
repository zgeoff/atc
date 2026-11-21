import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import type { ImpRelayConnection } from '../port/imp-port';
import { createStubImpForwards } from './create-stub-imp-forwards';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-imp-forwards-');
  const calls: string[] = [];
  const forwards = createStubImpForwards({ calls });
  const guestPath = join(temporaryDirectory.path, 'guest.sock');

  registerTestCleanup(() => {
    forwards.stop();
  });

  const connectGuest = async () => {
    const relay = Promise.withResolvers<ImpRelayConnection>();
    const received: string[] = [];
    const fromDaemon: string[] = [];
    const closed = Promise.withResolvers<void>();
    const relayed: ImpRelayConnection[] = [];

    const forward = forwards.openReverseForward('imp-a', guestPath, (connection) => {
      connection.onData((data) => {
        received.push(new TextDecoder().decode(data));
      });

      relayed.push(connection);
      relay.resolve(connection);
    });

    const guest = await Bun.connect({
      unix: guestPath,
      socket: {
        data: (_socket, data) => {
          fromDaemon.push(new TextDecoder().decode(data));
        },
        close: () => {
          closed.resolve();
        },
        error() {},
      },
    });

    registerTestCleanup(() => {
      guest.end();
    });

    return {
      forward,
      guest,
      relay: relay.promise,
      relayed,
      received,
      fromDaemon,
      closed: closed.promise,
    };
  };

  return { forwards, calls, guestPath, connectGuest };
}

test('it records the forward it opens', () => {
  const ctx = setupTest();

  ctx.forwards.openReverseForward('imp-a', ctx.guestPath, () => {});

  expect(ctx.calls).toStrictEqual([`reverse imp-a ${ctx.guestPath}`]);
});

test('it hands the daemon what a guest writes', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();

  run.guest.write('ping');

  await waitFor(() => {
    expect(run.received).toStrictEqual(['ping']);
  });
});

test('it sends the guest what the daemon writes', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();
  const relay = await run.relay;

  await relay.write(new TextEncoder().encode('pong'));

  await waitFor(() => {
    expect(run.fromDaemon).toStrictEqual(['pong']);
  });
});

test('it closes the guest when the daemon closes the relay', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();
  const relay = await run.relay;

  relay.close();

  await run.closed;
});

test('it ends a forward that is stopped with the stopped end and removes its socket', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();

  run.forward.stop();

  expect({ end: await run.forward.ended, socket: existsSync(ctx.guestPath) }).toStrictEqual({
    end: { kind: 'stopped' },
    socket: false,
  });
});

test('it ends every forward with the end it is given', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();

  ctx.forwards.stopForwards({ kind: 'lost' });

  const end = await run.forward.ended;

  expect(end).toStrictEqual({ kind: 'lost' });
});

test('it keeps the first end of a forward', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();

  ctx.forwards.stopForwards({ kind: 'lost' });
  ctx.forwards.stopForwards({ kind: 'failed', code: null, message: 'late' });

  const end = await run.forward.ended;

  expect(end).toStrictEqual({ kind: 'lost' });
});

test('it ends the guest connections without ending the forward when it stops the relays', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();

  await run.relay;

  ctx.forwards.stopRelays();

  await run.closed;

  expect(existsSync(ctx.guestPath)).toBeTrue();
});

test('it closes each new guest connection at once while it refuses relays', async () => {
  const ctx = setupTest();

  ctx.forwards.startRelayRefusal();

  const run = await ctx.connectGuest();

  await run.closed;

  expect(run.relayed).toStrictEqual([]);
});

test('it relays a guest connection again once it stops refusing relays', async () => {
  const ctx = setupTest();

  ctx.forwards.startRelayRefusal();
  ctx.forwards.stopRelayRefusal();

  const run = await ctx.connectGuest();

  expect(run.relay).resolves.toBeObject();
});

test('it throws away what a guest writes while it drops guest bytes, and counts them', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();

  await run.relay;

  ctx.forwards.startGuestByteDrop();
  run.guest.write('lost');

  await waitFor(() => {
    expect(ctx.forwards.countDroppedGuestBytes()).toBe(4);
  });

  expect(run.received).toStrictEqual([]);
});

test('it relays what a guest writes again once it stops dropping guest bytes', async () => {
  const ctx = setupTest();

  const run = await ctx.connectGuest();

  await run.relay;

  ctx.forwards.startGuestByteDrop();
  ctx.forwards.stopGuestByteDrop();
  run.guest.write('kept');

  await waitFor(() => {
    expect(run.received).toStrictEqual(['kept']);
  });
});

test('it notifies the daemon when the guest ends its side', async () => {
  const ctx = setupTest();
  const ended = Promise.withResolvers<void>();

  ctx.forwards.openReverseForward('imp-a', ctx.guestPath, (connection) => {
    connection.onEnd(() => {
      ended.resolve();
    });
  });

  const guest = await Bun.connect({ unix: ctx.guestPath, socket: { data() {}, error() {} } });

  guest.end();

  await ended.promise;
});
