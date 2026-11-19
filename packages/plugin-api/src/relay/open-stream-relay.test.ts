/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { expect, onTestFinished, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { formatRelayFrame } from '@atc/protocol/relay';
import type { HarnessRelay } from '../execution/execution-provider';
import { buildStubRelayLink } from '../test-utils/build-stub-relay-link';
import { openStreamRelay } from './open-stream-relay';

interface HelloAnswer {
  readonly ack: number;
  readonly reset: boolean;
}

function setupTest() {
  const clock = buildStubClock(0);
  const guest = buildStubRelayLink();
  const relays: HarnessRelay[] = [];
  const lines: string[] = [];
  const closes: number[] = [];

  const opened = openStreamRelay(
    guest.link,
    (relay) => {
      const index = relays.length;

      relays.push(relay);

      relay.onLine((line) => {
        lines.push(line);
      });

      relay.onClose(() => {
        closes.push(index);
      });
    },
    { reconnectDelaysMs: [100, 500], clock },
  );

  onTestFinished(() => {
    opened.stop();
  });

  // the daemon's hello is on the wire, and the guest welcomes it
  const welcome = async (answer: HelloAnswer, hellos: number) => {
    await waitFor(() => {
      expect(guest.readDaemonFrames().filter((frame) => frame.t === 'hello')).toHaveLength(hellos);
    });

    guest.answerHello(answer);
  };

  return { clock, guest, relays, lines, closes, opened, welcome };
}

test('it writes a newline before each hello', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  await ctx.opened.listening;

  expect(ctx.guest.readDaemonFrames().map((frame) => frame.t)).toStrictEqual(['hello']);
});

test('it delivers each guest frame once and in order across a dropped connection and a replay from byte 0', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  await ctx.opened.listening;

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });
  ctx.guest.writeGuestFrame({ t: 'line', seq: 2, conn: 1, line: 'one' });

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual(['one']);
  });

  ctx.guest.end('dropped');
  ctx.clock.advance(100);

  await ctx.welcome({ ack: 0, reset: false }, 2);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });
  ctx.guest.writeGuestFrame({ t: 'line', seq: 2, conn: 1, line: 'one' });
  ctx.guest.writeGuestFrame({ t: 'line', seq: 3, conn: 1, line: 'two' });

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual(['one', 'two']);
  });

  expect(ctx.relays).toHaveLength(1);
});

test('it acks the highest guest frame it applied', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });
  ctx.guest.writeGuestFrame({ t: 'line', seq: 2, conn: 1, line: 'one' });

  await waitFor(() => {
    expect(ctx.guest.readDaemonFrames().at(-1)).toStrictEqual({ t: 'ack', ack: 2 });
  });
});

test('it discards every byte before the welcome that echoes its own relay and generation', async () => {
  const ctx = setupTest();

  ctx.guest.writeGuestText(
    'motd\n{"t":"open","seq":1,"conn":9}\n{"t":"welcome","v":1,"relay":"old","gen":1,"ack":0,"reset":false}\n',
  );

  await ctx.welcome({ ack: 0, reset: true }, 1);

  await ctx.opened.listening;

  expect(ctx.relays).toHaveLength(0);
});

test('it counts a connection as dropped when no welcome follows its hello within 10 seconds', async () => {
  const ctx = setupTest();

  await waitFor(() => {
    expect(ctx.guest.openCount()).toBe(1);
  });

  ctx.clock.advance(10_000);
  ctx.clock.advance(100);

  await waitFor(() => {
    expect(ctx.guest.openCount()).toBe(2);
  });
});

test('it repeats the last reconnect delay until stop', async () => {
  const ctx = setupTest();

  await waitFor(() => {
    expect(ctx.guest.openCount()).toBe(1);
  });

  ctx.guest.failNextOpens(4);
  ctx.guest.end('dropped');

  for (const delayMs of [100, 500, 500]) {
    await waitFor(() => {
      expect(ctx.clock.collectPending()).toStrictEqual([delayMs]);
    });

    ctx.clock.advance(delayMs);
  }

  await waitFor(() => {
    expect(ctx.clock.collectDelays()).toStrictEqual([10_000, 100, 500, 500, 500]);
  });

  ctx.opened.stop();

  expect(ctx.clock.collectPending()).toStrictEqual([]);
});

test('it opens the link again with replace after a welcome of a version it cannot speak', async () => {
  const ctx = setupTest();

  await waitFor(() => {
    expect(ctx.guest.openCount()).toBe(1);
  });

  const hello = ctx.guest.readDaemonFrames().find((frame) => frame.t === 'hello');

  ctx.guest.writeGuestText(
    `{"t":"welcome","v":2,"relay":"${hello?.t === 'hello' ? hello.relay : ''}","gen":1}\n`,
  );

  await waitFor(() => {
    expect(ctx.guest.collectReplaceFlags()).toStrictEqual([false, true]);
  });
});

test('it closes every bridge connection and stops retrying when the host loses the mux', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  ctx.guest.end('lost');
  ctx.clock.advance(60_000);

  expect(ctx.closes).toStrictEqual([0]);
  expect(ctx.guest.openCount()).toBe(1);
});

test('it rejects listening when the host loses the mux before the first welcome', async () => {
  const ctx = setupTest();

  await waitFor(() => {
    expect(ctx.guest.openCount()).toBe(1);
  });

  ctx.guest.end('lost');

  expect(ctx.opened.listening).rejects.toThrow();
});

test('it closes the old bridge connections and renumbers from 1 on a reset after a new relay id', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  ctx.guest.end('dropped');
  ctx.clock.advance(100);

  await ctx.welcome({ ack: 0, reset: true }, 2);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });
  ctx.guest.writeGuestFrame({ t: 'line', seq: 2, conn: 1, line: 'fresh' });

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual(['fresh']);
  });

  expect(ctx.closes).toStrictEqual([0]);
  expect(ctx.relays).toHaveLength(2);
});

test('it resends each daemon frame the guest has not acked after a reconnect, once', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  await ctx.relays[0]?.writeLine('a');
  await ctx.relays[0]?.writeLine('b');

  ctx.guest.end('dropped');
  ctx.clock.advance(100);

  await ctx.welcome({ ack: 1, reset: false }, 2);

  await waitFor(() => {
    expect(
      ctx.guest.readDaemonFrames().filter((frame) => frame.t === 'line' && frame.seq === 2),
    ).toHaveLength(2);
  });

  expect(
    ctx.guest.readDaemonFrames().filter((frame) => frame.t === 'line' && frame.seq === 1),
  ).toHaveLength(1);
});

test('it settles writeLine only when its frame fits under 1 MiB of unacked frames', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  const big = 'x'.repeat(600 * 1024);
  const settled: string[] = [];

  const writeAndRecord = async (name: string) => {
    await ctx.relays[0]?.writeLine(big);

    settled.push(name);
  };

  void writeAndRecord('first');
  void writeAndRecord('second');

  await waitFor(() => {
    expect(settled).toStrictEqual(['first']);
  });

  ctx.guest.writeGuestFrame({ t: 'ack', ack: 1 });

  await waitFor(() => {
    expect(settled).toStrictEqual(['first', 'second']);
  });
});

test('it never admits more than 1 MiB of unacked frames', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  await expect(ctx.relays[0]?.writeLine('x'.repeat(2 * 1024 * 1024))).toReject();

  const half = 'x'.repeat(400 * 1024);

  await ctx.relays[0]?.writeLine(half);
  await ctx.relays[0]?.writeLine(half);

  const blocked = ctx.relays[0]?.writeLine(half);

  ctx.relays[0]?.close();

  const sentBytes = () =>
    ctx.guest
      .readDaemonFrames()
      .filter((frame) => frame.t === 'line' || frame.t === 'close')
      .reduce((total, frame) => total + formatRelayFrame(frame).length, 0);

  await waitFor(() => {
    expect(ctx.guest.readDaemonFrames().filter((frame) => frame.t === 'line')).toHaveLength(2);
  });

  expect(sentBytes()).toBeLessThanOrEqual(1024 * 1024);
  expect(ctx.guest.readDaemonFrames().filter((frame) => frame.t === 'close')).toHaveLength(0);

  ctx.guest.writeGuestFrame({ t: 'ack', ack: 1 });

  await expect(blocked).toResolve();

  await waitFor(() => {
    expect(ctx.guest.readDaemonFrames().filter((frame) => frame.t === 'close')).toHaveLength(1);
  });
});

test('it rejects a line whose frame outgrows the window when its sequence number gains a digit', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  // sequence numbers 1 to 7 are used and acked
  for (let index = 0; index < 7; index += 1) {
    await ctx.relays[0]?.writeLine('small');
  }

  ctx.guest.writeGuestFrame({ t: 'ack', ack: 7 });

  // the filler holds sequence number 8 unacked, so both big lines wait with next seq 9
  await ctx.relays[0]?.writeLine('filler');

  const windowBytes = 1024 * 1024;
  const overhead = formatRelayFrame({ t: 'line', seq: 9, conn: 1, line: '' }).length;
  const exact = 'x'.repeat(windowBytes - overhead);

  const outcomes = Promise.allSettled([
    ctx.relays[0]?.writeLine(exact),
    ctx.relays[0]?.writeLine(exact),
  ]);

  ctx.guest.writeGuestFrame({ t: 'ack', ack: 8 });

  const [fitsAtNine, growsAtTen] = await outcomes;

  expect(fitsAtNine?.status).toBe('fulfilled');
  expect(growsAtTen?.status).toBe('rejected');
});

test('it rejects a pending writeLine when the relay stops', async () => {
  const ctx = setupTest();

  await ctx.welcome({ ack: 0, reset: true }, 1);

  ctx.guest.writeGuestFrame({ t: 'open', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  const big = 'x'.repeat(600 * 1024);

  void ctx.relays[0]?.writeLine(big);
  const blocked = ctx.relays[0]?.writeLine(big);

  ctx.opened.stop();

  await expect(blocked).toReject();

  expect(ctx.closes).toStrictEqual([0]);
});
