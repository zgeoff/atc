import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import type { ImpSessionStarted } from '../daemon/imp-port';
import { isProcessAlive } from '../shared/is-process-alive';
import { buildMockImpIdentity } from './build-mock-imp-identity';
import { buildStubClock } from './build-stub-clock';
import { createStubImpPort } from './create-stub-imp-port';
import { KEYS } from './keys';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// The port under test and a temp directory its sessions and guest sockets
// run in; once the test finishes, the port kills every process it started
// before the directory goes.
function setupTest() {
  const tmp = setupTempDir('atc-stub-imp-port-');
  const port = createStubImpPort();

  return { port, dir: tmp.dir };
}

test('it refuses a lease under the label hold', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  expect(ctx.port.acquireLease('imp-a', 'hold', 60)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses to sleep a leased imp with the leases it shows and a count of the rest', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  ctx.port.acquireOtherLease('imp-a', 'token:other', 'build', 60);

  expect(ctx.port.suspendImp('imp-a')).rejects.toMatchObject({
    code: 'LEASED',
    data: {
      leases: [{ owner: { label: 'atc-d1' } }],
      otherCount: 1,
    },
  });
});

test('it sleeps an imp once the caller released its own lease', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);
  await ctx.port.releaseLease('imp-a', 'atc-d1');
  await ctx.port.suspendImp('imp-a');

  expect(ctx.port.findState('imp-a')).toBe('sleeping');
});

test('it refuses a renewal of a lease a forced sleep ended', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  ctx.port.suspendWithForce('imp-a');

  expect(ctx.port.renewLease('imp-a', 'atc-d1', 60)).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it refuses a renewal of a lease that has expired', async () => {
  const clock = buildStubClock(Date.parse('2026-10-09T00:00:00.000Z'));
  const port = createStubImpPort('token:atc', clock.now);

  await port.createImp({ name: 'imp-a' });
  await port.acquireLease('imp-a', 'atc-d1', 60);

  clock.advance(60_000);

  expect(port.renewLease('imp-a', 'atc-d1', 60)).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it sleeps an imp whose leases have all expired', async () => {
  const clock = buildStubClock(Date.parse('2026-10-09T00:00:00.000Z'));
  const port = createStubImpPort('token:atc', clock.now);

  await port.createImp({ name: 'imp-a' });
  await port.acquireLease('imp-a', 'atc-d1', 60);

  port.acquireOtherLease('imp-a', 'token:other', 'build', 30);
  clock.advance(60_000);

  await port.suspendImp('imp-a');

  expect(port.findState('imp-a')).toBe('sleeping');
});

test('it leaves expired leases out of the view of an imp', async () => {
  const clock = buildStubClock(Date.parse('2026-10-09T00:00:00.000Z'));
  const port = createStubImpPort('token:atc', clock.now);

  await port.createImp({ name: 'imp-a' });
  await port.acquireLease('imp-a', 'atc-d1', 60);
  await port.acquireLease('imp-a', 'atc-d2', 120);

  port.acquireOtherLease('imp-a', 'token:other', 'build', 30);
  clock.advance(60_000);

  const view = await port.readImp('imp-a');

  expect(view).toStrictEqual({
    id: expect.toBeString(),
    name: 'imp-a',
    state: 'running',
    leases: [
      {
        name: 'imp-a',
        owner: { principal: 'token:atc', display: 'token:atc', label: 'atc-d2' },
        until: Date.parse('2026-10-09T00:02:00.000Z'),
      },
    ],
    otherLeaseCount: 0,
  });
});

test('it streams a started session with offsets and delivers its exit with the end', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const started: ImpSessionStarted[] = [];
  const chunks: Uint8Array[] = [];

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['printf', 'hello'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  const outcome = await connection.outcome;

  expect(started).toStrictEqual([
    {
      created: true,
      output: {
        continuity: 'offsets',
        bootId: ctx.port.getBootID('imp-a'),
        executionGeneration: expect.toSatisfy((value: string) => /^[0-9a-f]{32}$/.test(value)),
        bufferStart: 0,
        end: 0,
        offset: 0,
        prelude: 0,
        coldBoots: [
          { bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() },
        ],
      },
    },
  ]);

  expect(Buffer.concat(chunks).toString()).toBe('hello');
  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 5 });
});

test('it resumes a running generation from the exact offset asked for', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const first: ImpSessionStarted[] = [];

  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'printf abcdef; sleep 30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: (s) => {
        first.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(6);
  });

  opened.close();

  const output = first[0]?.output;

  invariant(output?.continuity === 'offsets', 'the start carried no offsets');

  const started: ImpSessionStarted[] = [];
  const chunks: Uint8Array[] = [];

  ctx.port.openSession(
    {
      kind: 'attach',
      name: 'imp-a',
      session: 's1',
      cols: 80,
      rows: 24,
      resumeFrom: { executionGeneration: output.executionGeneration, offset: 4 },
      wake: false,
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toBe('ef');
  });

  expect(started).toStrictEqual([
    {
      created: false,
      output: {
        continuity: 'offsets',
        bootId: output.bootId,
        executionGeneration: output.executionGeneration,
        bufferStart: 0,
        end: 6,
        offset: 4,
        prelude: 0,
        coldBoots: output.coldBoots,
        resume: { kind: 'exact' },
      },
    },
  ]);
});

test('it answers a resume below the ring with a gap and data from the ring start', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const first: ImpSessionStarted[] = [];

  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', String.raw`head -c 300000 /dev/zero | tr '\0' x; sleep 30`],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: (s) => {
        first.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(300_000);
  });

  opened.close();

  const output = first[0]?.output;

  invariant(output?.continuity === 'offsets', 'the start carried no offsets');

  const started: ImpSessionStarted[] = [];

  ctx.port.openSession(
    {
      kind: 'attach',
      name: 'imp-a',
      session: 's1',
      cols: 80,
      rows: 24,
      resumeFrom: { executionGeneration: output.executionGeneration, offset: 0 },
      wake: false,
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(started).toHaveLength(1);
  });

  expect(started).toStrictEqual([
    {
      created: false,
      output: {
        continuity: 'offsets',
        bootId: output.bootId,
        executionGeneration: output.executionGeneration,
        bufferStart: 37_856,
        end: 300_000,
        offset: 37_856,
        prelude: 0,
        coldBoots: output.coldBoots,
        resume: { kind: 'gap', from: 0, to: 37_856 },
      },
    },
  ]);
});

test('it refuses a resume past the end with INVALID_RESUME', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const first: ImpSessionStarted[] = [];

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: (s) => {
        first.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(first).toHaveLength(1);
  });

  const output = first[0]?.output;

  invariant(output?.continuity === 'offsets', 'the start carried no offsets');

  const resumed = ctx.port.openSession(
    {
      kind: 'attach',
      name: 'imp-a',
      session: 's1',
      cols: 80,
      rows: 24,
      resumeFrom: { executionGeneration: output.executionGeneration, offset: 99 },
      wake: false,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const ended = await resumed.outcome;

  expect(ended).toStrictEqual({
    kind: 'failed',
    code: 'INVALID_RESUME',
    message: expect.toBeString(),
    data: { end: 0, bufferStart: 0 },
  });
});

test('it answers an attach to a sleeping imp without wake with INVALID_STATE', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.suspendImp('imp-a');

  const attached = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const ended = await attached.outcome;

  expect(ended).toStrictEqual({
    kind: 'failed',
    code: 'INVALID_STATE',
    message: expect.toBeString(),
    data: {
      state: 'sleeping',
      allowed: ['running'],
      coldBoots: [{ bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() }],
    },
  });

  expect(ctx.port.findState('imp-a')).toBe('sleeping');
});

test('it answers an attach after a cold boot with NO_SESSION and the boot that ended it', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(0);
  });

  const startBoot = ctx.port.getBootID('imp-a');

  ctx.port.bootImpCold('imp-a', 'wake_fallback');

  const attached = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const ended = await attached.outcome;

  expect(ended).toStrictEqual({
    kind: 'failed',
    code: 'NO_SESSION',
    message: expect.toBeString(),
    data: {
      bootId: ctx.port.getBootID('imp-a'),
      coldBoots: [
        { bootId: ctx.port.getBootID('imp-a'), cause: 'wake_fallback', at: expect.toBeString() },
        { bootId: startBoot, cause: 'start', at: expect.toBeString() },
      ],
    },
  });
});

test('it keeps the last four cold boots, newest first', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  for (const cause of ['watchdog', 'restore', 'recovery', 'wake_fallback'] as const) {
    ctx.port.bootImpCold('imp-a', cause);
  }

  const started: ImpSessionStarted[] = [];

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(started).toHaveLength(1);
  });

  expect(started).toStrictEqual([
    {
      created: true,
      output: {
        continuity: 'offsets',
        bootId: expect.toBeString(),
        executionGeneration: expect.toBeString(),
        bufferStart: 0,
        end: 0,
        offset: 0,
        prelude: 0,
        coldBoots: [
          { bootId: expect.toBeString(), cause: 'wake_fallback', at: expect.toBeString() },
          { bootId: expect.toBeString(), cause: 'recovery', at: expect.toBeString() },
          { bootId: expect.toBeString(), cause: 'restore', at: expect.toBeString() },
          { bootId: expect.toBeString(), cause: 'watchdog', at: expect.toBeString() },
        ],
      },
    },
  ]);
});

test('it replays without offsets and ignores a resume for an agent without continuity', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.continuity = 'none';

  const started: ImpSessionStarted[] = [];

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      resumeFrom: { executionGeneration: 'f'.repeat(32), offset: 0 },
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(started).toStrictEqual([{ created: true, output: { continuity: 'none' } }]);
  });
});

test('it closes a connection with the close code a test drops it with', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(0);
  });

  ctx.port.stopConnection('imp-a', 's1', 1011);

  const ended = await opened.outcome;

  expect(ended).toStrictEqual({
    kind: 'closed',
    reason: 'code 1011',
    closeCode: 1011,
  });
});

test('it ends a connection whose output handler throws with a local error and keeps the process', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'echo $$ > "$1"; echo hi; exec sleep 30', 'bash', join(ctx.dir, 'pid')],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {},
      onOutput: () => {
        throw new Error('write EPIPE');
      },
    },
  );

  const ended = await opened.outcome;

  const pid = Number(readFileSync(join(ctx.dir, 'pid'), 'utf8'));

  expect(ended).toStrictEqual({ kind: 'local_error', detail: 'write EPIPE' });
  expect(() => process.kill(pid, 0)).not.toThrow();
});

test('it detaches the earlier connection when a second one attaches', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(0);
  });

  ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const ended = await opened.outcome;

  expect(ended).toStrictEqual({
    kind: 'detached',
    reason: 'taken_over',
    offset: 0,
  });
});

test('it relays each guest connection on a reverse forward to the daemon', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const received: string[] = [];
  const guestPath = join(ctx.dir, 'guest.sock');

  ctx.port.openReverseForward('imp-a', guestPath, (connection) => {
    connection.onData((data) => {
      received.push(Buffer.from(data).toString());
    });
  });

  const socket = await Bun.connect({ unix: guestPath, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('report\n');

  await waitFor(() => {
    expect(received.join('')).toBe('report\n');
  });
});

test('it writes every byte the daemon sends to the guest end of a relayed connection', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const guestPath = join(ctx.dir, 'guest.sock');

  const sent = new Uint8Array(4 * 1024 * 1024).fill(97);

  let received = 0;

  ctx.port.openReverseForward('imp-a', guestPath, (connection) => {
    void connection.write(sent);
  });

  const socket = await Bun.connect({
    unix: guestPath,
    socket: {
      data(_socket, buf) {
        received += buf.length;
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  await waitFor(() => {
    expect(received).toBe(sent.length);
  });
});

test('it closes every guest connection on its forwards', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const guestPath = join(ctx.dir, 'guest.sock');
  let connections = 0;
  const closed = Promise.withResolvers<void>();

  ctx.port.openReverseForward('imp-a', guestPath, () => {
    connections += 1;
  });

  const socket = await Bun.connect({
    unix: guestPath,
    socket: {
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  await waitFor(() => {
    expect(connections).toBe(1);
  });

  ctx.port.stopRelays();

  await expect(closed.promise).toResolve();
});

test('it keeps listening for the next guest connection after it closes every one', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const guestPath = join(ctx.dir, 'guest.sock');
  let connections = 0;
  const closed = Promise.withResolvers<void>();

  ctx.port.openReverseForward('imp-a', guestPath, () => {
    connections += 1;
  });

  const first = await Bun.connect({
    unix: guestPath,
    socket: {
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    first.end();
  });

  await waitFor(() => {
    expect(connections).toBe(1);
  });

  ctx.port.stopRelays();

  await closed.promise;

  const second = await Bun.connect({ unix: guestPath, socket: { data() {} } });

  registerTestCleanup(() => {
    second.end();
  });

  await waitFor(() => {
    expect(connections).toBe(2);
  });
});

test('it closes each new guest connection without relaying it while relays are refused', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const guestPath = join(ctx.dir, 'guest.sock');
  let connections = 0;
  const closed = Promise.withResolvers<void>();

  ctx.port.openReverseForward('imp-a', guestPath, () => {
    connections += 1;
  });

  ctx.port.startRelayRefusal();

  const socket = await Bun.connect({
    unix: guestPath,
    socket: {
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  await closed.promise;

  expect(connections).toBe(0);
});

test('it relays guest connections again once the refusal stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const guestPath = join(ctx.dir, 'guest.sock');
  let connections = 0;

  ctx.port.openReverseForward('imp-a', guestPath, () => {
    connections += 1;
  });

  ctx.port.startRelayRefusal();

  const refusedClosed = Promise.withResolvers<void>();

  const refused = await Bun.connect({
    unix: guestPath,
    socket: {
      data() {},
      close() {
        refusedClosed.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    refused.end();
  });

  await refusedClosed.promise;

  const relayedWhileRefused = connections;

  ctx.port.stopRelayRefusal();

  const socket = await Bun.connect({ unix: guestPath, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  await waitFor(() => {
    expect(connections).toBe(1);
  });

  expect(relayedWhileRefused).toBe(0);
  expect(connections).toBe(1);
});

test('it drops what a guest writes while guest bytes are dropped', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const received: string[] = [];
  const guestPath = join(ctx.dir, 'guest.sock');

  ctx.port.openReverseForward('imp-a', guestPath, (connection) => {
    connection.onData((data) => {
      received.push(Buffer.from(data).toString());
    });
  });

  ctx.port.startGuestByteDrop();

  const socket = await Bun.connect({ unix: guestPath, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('lost\n');

  await waitFor(() => {
    expect(ctx.port.countDroppedGuestBytes()).toBe(5);
  });

  expect(received).toStrictEqual([]);
});

test('it relays what a guest writes once the drop stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const received: string[] = [];
  const guestPath = join(ctx.dir, 'guest.sock');

  ctx.port.openReverseForward('imp-a', guestPath, (connection) => {
    connection.onData((data) => {
      received.push(Buffer.from(data).toString());
    });
  });

  ctx.port.startGuestByteDrop();

  const socket = await Bun.connect({ unix: guestPath, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('lost\n');

  await waitFor(() => {
    expect(ctx.port.countDroppedGuestBytes()).toBe(5);
  });

  const receivedWhileDropped = received.join('');

  ctx.port.stopGuestByteDrop();
  socket.write('kept\n');

  await waitFor(() => {
    expect(received.join('')).toBe('kept\n');
  });

  expect(receivedWhileDropped).toBe('');
  expect(ctx.port.countDroppedGuestBytes()).toBe(5);
  expect(received.join('')).toBe('kept\n');
});

test('it still writes what the daemon sends to the guest while guest bytes are dropped', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const guestPath = join(ctx.dir, 'guest.sock');
  const received: string[] = [];

  ctx.port.openReverseForward('imp-a', guestPath, (connection) => {
    void connection.write(new TextEncoder().encode('to guest\n'));
  });

  ctx.port.startGuestByteDrop();

  const socket = await Bun.connect({
    unix: guestPath,
    socket: {
      data(_socket, buf) {
        received.push(buf.toString());
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  await waitFor(() => {
    expect(received.join('')).toBe('to guest\n');
  });
});

test('it runs a command in a running imp with the input it is given', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const result = await ctx.port.runCommand('imp-a', {
    argv: ['cat'],
    stdin: new TextEncoder().encode('piped'),
  });

  expect({ ...result, stdout: Buffer.from(result.stdout).toString() }).toStrictEqual({
    code: 0,
    stdout: 'piped',
    stderr: new Uint8Array(0),
  });
});

test('it runs a command with the guest home as HOME once the test gives one', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setHomeDir(ctx.dir);

  const result = await ctx.port.runCommand('imp-a', {
    argv: ['sh', '-c', 'cd && pwd'],
    cwd: '/',
  });

  expect(Buffer.from(result.stdout).toString()).toBe(`${ctx.dir}\n`);
});

test('it ends the output and exit of a command that runs while a session PTY opens in its imp', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const go = join(ctx.dir, 'go');

  const result = ctx.port.runCommand('imp-a', {
    argv: [
      'sh',
      '-c',
      'while [ ! -e "$1" ]; do sleep 0.01; done; echo out; echo err >&2',
      'sh',
      go,
    ],
  });

  const started = Promise.withResolvers<void>();

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {
        started.resolve();
      },
      onOutput: () => {},
    },
  );

  await started.promise;

  writeFileSync(go, '');

  const ran = await result;

  expect({
    code: ran.code,
    stdout: Buffer.from(ran.stdout).toString(),
    stderr: Buffer.from(ran.stderr).toString(),
  }).toStrictEqual({ code: 0, stdout: 'out\n', stderr: 'err\n' });
});

test('it holds a matching command and gives the held argv on entry', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const hold = ctx.port.startCommandHold('echo held');

  void ctx.port.runCommand('imp-a', { argv: ['sh', '-c', 'echo held'] });

  const held = await hold.entered;

  expect(held).toBe('sh -c echo held');
});

test('it runs a held command once its hold stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const hold = ctx.port.startCommandHold('echo held');
  const result = ctx.port.runCommand('imp-a', { argv: ['sh', '-c', 'echo held'] });

  await hold.entered;

  hold.stop();

  const ran = await result;

  expect(Buffer.from(ran.stdout).toString()).toBe('held\n');
});

test('it keeps a held command waiting until its hold stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const marker = join(ctx.dir, 'held-ran');
  const hold = ctx.port.startCommandHold('held-ran');
  const result = ctx.port.runCommand('imp-a', { argv: ['touch', marker] });

  await hold.entered;

  // An unheld command runs to its end across many turns of the event loop,
  // so a hold that let its command go would have counted it out by then.
  await ctx.port.runCommand('imp-a', { argv: ['sh', '-c', 'true'] });

  expect(ctx.port.countHeldCommands()).toBe(1);
  expect(Bun.peek.status(result)).toBe('pending');
  expect(existsSync(marker)).toBe(false);
});

test('it counts no held command once the command hold stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const hold = ctx.port.startCommandHold('echo held');
  const result = ctx.port.runCommand('imp-a', { argv: ['sh', '-c', 'echo held'] });

  await hold.entered;

  hold.stop();

  await result;

  expect(ctx.port.countHeldCommands()).toBe(0);
});

test('it runs every held command once the active hold stops from the port', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const hold = ctx.port.startCommandHold('echo held');
  const result = ctx.port.runCommand('imp-a', { argv: ['sh', '-c', 'echo held'] });

  await hold.entered;

  ctx.port.stopCommandHold();

  const ran = await result;

  expect(Buffer.from(ran.stdout).toString()).toBe('held\n');
});

test('it ends a held command as killed without running it once the port stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const marker = join(ctx.dir, 'held-ran');
  const hold = ctx.port.startCommandHold('held-ran');
  const result = ctx.port.runCommand('imp-a', { argv: ['touch', marker] });

  await hold.entered;

  await ctx.port.stop();

  const ran = await result;

  expect(ran.code).toBe(137);
  expect(existsSync(marker)).toBeFalse();
});

test('it kills a running command once the port stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const marker = join(ctx.dir, 'started');

  const result = ctx.port.runCommand('imp-a', {
    argv: ['sh', '-c', 'touch "$1"; exec sleep 30', 'sh', marker],
  });

  await waitFor(() => {
    expect(existsSync(marker)).toBeTrue();
  });

  await ctx.port.stop();

  const ran = await result;

  expect(ran.code).toBe(137);
});

test('it runs a command whose argv does not hold the held text at once', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.startCommandHold('tar -x');

  const ran = await ctx.port.runCommand('imp-a', { argv: ['echo', 'free'] });

  expect(Buffer.from(ran.stdout).toString()).toBe('free\n');
});

test('it refuses a second command hold while one is active', () => {
  const ctx = setupTest();

  ctx.port.startCommandHold('tar -x');

  expect(() => ctx.port.startCommandHold('pwd -P')).toThrowWithMessage(
    Error,
    'a hold on tar -x is still active',
  );
});

test('it keeps a newer command hold active when an earlier hold stops again', () => {
  const ctx = setupTest();
  const earlier = ctx.port.startCommandHold('tar -x');

  earlier.stop();
  ctx.port.startCommandHold('pwd -P');
  earlier.stop();

  expect(() => ctx.port.startCommandHold('mkdir')).toThrowWithMessage(
    Error,
    'a hold on pwd -P is still active',
  );
});

test('it gives each imp made under a name a new id', async () => {
  const ctx = setupTest();

  const first = await ctx.port.createImp({ name: 'imp-a' });

  await ctx.port.destroyImp('imp-a');

  const second = await ctx.port.createImp({ name: 'imp-a' });

  expect(second.id).not.toBe(first.id);
});

test('it reads the imp made last under a name', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.destroyImp('imp-a');

  const second = await ctx.port.createImp({ name: 'imp-a' });
  const view = await ctx.port.readImp('imp-a');

  expect(view).toStrictEqual({
    id: second.id,
    name: 'imp-a',
    state: 'running',
    leases: [],
    otherLeaseCount: 0,
  });
});

test('it reports the features of an old daemon without the grant and exec requirement flags', async () => {
  const ctx = setupTest();

  ctx.port.setOldDaemonFeatures();

  const features = await ctx.port.readFeatures();

  expect(features).toStrictEqual({
    sessionOffsets: true,
    leases: true,
    grantableTokens: false,
    secretRebind: false,
    execRequire: false,
    oauthSecrets: false,
  });
});

test('it answers tokens.whoami with the identity a test set', async () => {
  const ctx = setupTest();
  const set = buildMockImpIdentity({ grantable: ['glm'] });

  ctx.port.setIdentity(set);

  const identity = await ctx.port.readIdentity();

  expect(identity).toBe(set);
  expect(ctx.port.calls).toStrictEqual(['tokens.whoami']);
});

test('it grants a secret to an imp within the patterns once however often it is granted', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');
  await ctx.port.createGrant('atc-s1', 'glm');

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
});

test('it lists each secret with the imps it is granted to', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  const secrets = await ctx.port.readSecrets();

  expect(secrets).toStrictEqual([
    {
      name: 'glm',
      kind: 'custom',
      rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      imps: ['atc-s1'],
    },
  ]);
});

test('it lists the sign-in state of an oauth secret', async () => {
  const ctx = setupTest();

  ctx.port.createSecret(
    'claude',
    'oauth',
    [{ host: 'api.anthropic.com', header: 'authorization', scheme: 'bearer' }],
    { status: 'ready', idClaims: null },
  );

  const secrets = await ctx.port.readSecrets();

  expect(secrets).toStrictEqual([
    {
      name: 'claude',
      kind: 'oauth',
      rules: [{ host: 'api.anthropic.com', header: 'authorization', scheme: 'bearer' }],
      imps: [],
      oauth: { status: 'ready', idClaims: null },
    },
  ]);
});

test('it records each grant call it receives in order', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');
  await ctx.port.readGrants('atc-s1');
  await ctx.port.readSecrets();

  expect(ctx.port.calls).toStrictEqual([
    'imps.create atc-s1',
    'grants.add atc-s1 glm',
    'grants.list atc-s1',
    'secrets.list',
  ]);
});

test('it refuses a grant of a secret the token may not grant', async () => {
  const ctx = setupTest();

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });

  expect(ctx.port.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it refuses a grant to an imp outside the token patterns', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ imps: ['atc-*'], grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'imp-a' });

  expect(ctx.port.createGrant('imp-a', 'glm')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'imp_out_of_scope' },
  });
});

test('it refuses a grant from a token without the manage scope', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ scope: 'read', grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });

  expect(ctx.port.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'scope' },
  });
});

test('it refuses a grant of a secret impd does not hold', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  await ctx.port.createImp({ name: 'atc-s1' });

  expect(ctx.port.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret', name: 'glm' },
  });
});

test('it refuses a second secret for a host another grant covers', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm', 'glm-b'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('glm-b', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  expect(ctx.port.createGrant('atc-s1', 'glm-b')).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'grant', name: 'atc-s1/glm' },
  });
});

test('it revokes a held grant', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  const removed = await ctx.port.removeGrant('atc-s1', 'glm');

  expect(removed).toBeTrue();
});

test('it reports a revoke of a grant already revoked as nothing removed', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');
  await ctx.port.removeGrant('atc-s1', 'glm');

  const removed = await ctx.port.removeGrant('atc-s1', 'glm');

  expect(removed).toBeFalse();
});

test('it lists no grant of a revoked secret', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');
  await ctx.port.removeGrant('atc-s1', 'glm');

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual([]);
});

test('it fails every grant removal with the code it is given while removals fail', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.setGrantRemovalFailure('UNAVAILABLE');

  expect(ctx.port.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'impd did not remove the grant',
  });
});

test('it removes grants again once the removal failure is cleared', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.setGrantRemovalFailure('UNAVAILABLE');

  const failedRemoval = ctx.port.removeGrant('atc-s1', 'glm');

  await Promise.allSettled([failedRemoval]);

  ctx.port.setGrantRemovalFailure(null);

  const removed = await ctx.port.removeGrant('atc-s1', 'glm');

  expect(failedRemoval).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'impd did not remove the grant',
  });

  expect(removed).toBeTrue();
});

test('it drops every grant of a rebound secret', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual([]);
});

test('it stops the token granting a rebound secret', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);

  expect(ctx.port.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it lets the token grant a rebound secret again once its identity is set anew', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);
  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  await ctx.port.createGrant('atc-s1', 'glm');

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
});

test('it refuses to rebind a secret impd does not hold', () => {
  const ctx = setupTest();

  expect(() => {
    ctx.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);
  }).toThrowWithMessage(Error, 'no secret glm');
});

test('it drops every grant of a removed secret', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.removeSecret('glm');

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual([]);
});

test('it stops the token granting a secret made again under a removed name', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.removeSecret('glm');

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  expect(ctx.port.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it drops the grants of a destroyed imp', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');
  await ctx.port.destroyImp('atc-s1');
  await ctx.port.createImp({ name: 'atc-s1' });

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual([]);
});

test('it refuses a start that requires the broker on an imp without a grant and runs nothing', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'atc-s1' });

  const started: ImpSessionStarted[] = [];

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['touch', join(ctx.dir, 'ran')],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  const outcome = await connection.outcome;
  const ran = await Bun.file(join(ctx.dir, 'ran')).exists();

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready in imp atc-s1',
    data: { reason: 'broker_not_ready', detail: 'the imp holds no grant' },
  });

  expect(started).toStrictEqual([]);
  expect(ran).toBe(false);
});

test('it refuses a start that requires the broker while the broker fails, though the imp holds a grant', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.startBrokerFailure();

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['touch', join(ctx.dir, 'ran')],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;
  const ran = await Bun.file(join(ctx.dir, 'ran')).exists();

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready in imp atc-s1',
    data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
  });

  expect(ran).toBe(false);
});

test('it runs a start that requires the broker on an imp with a grant and a working broker', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['printf', 'ran'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 3 });
});

test('it runs a start that requires nothing while the broker fails', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.startBrokerFailure();

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['printf', 'ran'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 3 });
});

test('it refuses a start that requires the broker and sets a broker variable, with the variable as the detail', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['touch', join(ctx.dir, 'ran')],
      env: { HTTPS_PROXY: 'http://proxy.example:3128' },
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;
  const ran = await Bun.file(join(ctx.dir, 'ran')).exists();

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready in imp atc-s1',
    data: { reason: 'broker_not_ready', detail: 'HTTPS_PROXY' },
  });

  expect(ran).toBe(false);
});

test('it lets an attach that requires the broker join a session that started with it required', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  const first = Promise.withResolvers<void>();

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      onStarted: () => {
        first.resolve();
      },
      onOutput: () => {},
    },
  );

  await first.promise;

  const joined: ImpSessionStarted[] = [];

  ctx.port.openSession(
    {
      kind: 'attach',
      name: 'atc-s1',
      session: 's1',
      cols: 80,
      rows: 24,
      wake: false,
      require: ['broker'],
    },
    {
      onStarted: (started) => {
        joined.push(started);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(joined).toHaveLength(1);
  });

  expect(joined).toStrictEqual([
    {
      created: false,
      output: {
        continuity: 'offsets',
        bootId: ctx.port.getBootID('atc-s1'),
        executionGeneration: ctx.port.getGeneration('atc-s1', 's1'),
        bufferStart: 0,
        end: 0,
        offset: 0,
        prelude: 0,
        coldBoots: [
          { bootId: ctx.port.getBootID('atc-s1'), cause: 'start', at: expect.toBeString() },
        ],
      },
    },
  ]);
});

test('it refuses an attach that requires the broker to a session that started without it required', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  const first = Promise.withResolvers<void>();

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {
        first.resolve();
      },
      onOutput: () => {},
    },
  );

  await first.promise;

  const connection = ctx.port.openSession(
    {
      kind: 'attach',
      name: 'atc-s1',
      session: 's1',
      cols: 80,
      rows: 24,
      wake: false,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready in imp atc-s1',
    data: {
      reason: 'broker_not_ready',
      detail: 'the session did not start with the broker required',
    },
  });
});

test('it refuses a lease whose time to live is under ten seconds', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  expect(ctx.port.acquireLease('imp-a', 'atc-d1', 9)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses a lease on an imp it does not hold with NOT_FOUND', () => {
  const ctx = setupTest();

  expect(ctx.port.acquireLease('imp-a', 'atc-d1', 60)).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'imp-a' },
  });
});

test('it wakes a sleeping imp that a lease is acquired on', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.suspendImp('imp-a');
  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  expect(ctx.port.findState('imp-a')).toBe('running');
});

test('it renews a lease the caller holds for the new time to live', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  const renewed = await ctx.port.renewLease('imp-a', 'atc-d1', 600);

  expect(renewed).toStrictEqual({
    name: 'imp-a',
    owner: { principal: 'token:atc', display: 'token:atc', label: 'atc-d1' },
    until: expect.toBeWithin(Date.now() + 590_000, Date.now() + 601_000),
  });
});

test('it refuses to create an imp under a name it already holds with CONFLICT', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  expect(ctx.port.createImp({ name: 'imp-a' })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'imp', name: 'imp-a' },
  });
});

test('it reads no imp under a name it does not hold', async () => {
  const ctx = setupTest();

  const view = await ctx.port.readImp('imp-a');

  expect(view).toBeNull();
});

test('it reads no state for an imp it does not hold', () => {
  const ctx = setupTest();

  expect(ctx.port.findState('imp-a')).toBeNull();
});

test('it collects the names of the imps it holds', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.createImp({ name: 'imp-b' });

  expect(ctx.port.collectImpNames()).toStrictEqual(['imp-a', 'imp-b']);
});

test('it fails a lease acquisition with the code it is given once the skipped ones go through', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setAcquireFailure(1, 'UNAVAILABLE');

  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  expect(ctx.port.acquireLease('imp-a', 'atc-d2', 60)).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'impd refused the lease (UNAVAILABLE)',
  });
});

test('it lets lease acquisitions through again after the one failure', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setAcquireFailure(0, 'UNAVAILABLE');

  const failedAcquire = ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  await Promise.allSettled([failedAcquire]);

  const lease = await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  expect(failedAcquire).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'impd refused the lease (UNAVAILABLE)',
  });

  expect(lease.owner.label).toBe('atc-d1');
});

test('it holds a lease acquisition while the lease hold lasts', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.startLeaseHold();

  const acquiring = ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  await waitFor(() => {
    expect(ctx.port.countHeldLeases()).toBe(1);
  });

  expect(Bun.peek.status(acquiring)).toBe('pending');
});

test('it lets a held lease acquisition through once the lease hold stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.startLeaseHold();

  const acquiring = ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  await waitFor(() => {
    expect(ctx.port.countHeldLeases()).toBe(1);
  });

  const statusWhileHeld = Bun.peek.status(acquiring);

  ctx.port.stopLeaseHold();

  const lease = await acquiring;

  expect(statusWhileHeld).toBe('pending');
  expect(lease.owner.label).toBe('atc-d1');
});

test('it holds a lease release while the release hold lasts', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  ctx.port.startReleaseHold();

  const releasing = ctx.port.releaseLease('imp-a', 'atc-d1');

  await waitFor(() => {
    expect(ctx.port.countHeldReleases()).toBe(1);
  });

  expect(Bun.peek.status(releasing)).toBe('pending');
});

test('it lets a held lease release through once the release hold stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.acquireLease('imp-a', 'atc-d1', 60);

  ctx.port.startReleaseHold();

  const releasing = ctx.port.releaseLease('imp-a', 'atc-d1');

  await waitFor(() => {
    expect(ctx.port.countHeldReleases()).toBe(1);
  });

  const statusWhileHeld = Bun.peek.status(releasing);

  ctx.port.stopReleaseHold();

  const released = await releasing;

  expect(statusWhileHeld).toBe('pending');
  expect(released).toBeTrue();
});

test('it fails every imp destroy with the code it is given while destroys fail', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setDestroyFailure('UNAVAILABLE');

  expect(ctx.port.destroyImp('imp-a')).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'impd could not destroy imp-a',
  });
});

test('it keeps the imp a failed destroy left', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setDestroyFailure('UNAVAILABLE');

  await Promise.allSettled([ctx.port.destroyImp('imp-a')]);

  expect(ctx.port.collectImpNames()).toStrictEqual(['imp-a']);
});

test('it destroys imps again once the destroy failure is cleared', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setDestroyFailure('UNAVAILABLE');

  const failedDestroy = ctx.port.destroyImp('imp-a');

  await Promise.allSettled([failedDestroy]);

  ctx.port.setDestroyFailure(null);

  await ctx.port.destroyImp('imp-a');

  expect(failedDestroy).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'impd could not destroy imp-a',
  });

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
});

test('it fails the next feature reads as an unreachable impd', () => {
  const ctx = setupTest();

  ctx.port.setFeatureFailures(1);

  expect(ctx.port.readFeatures()).rejects.toMatchObject({
    code: 'UNREACHABLE',
    message: 'impd did not answer',
  });
});

test('it answers a feature read once the failures are spent', async () => {
  const ctx = setupTest();

  ctx.port.setFeatureFailures(1);

  const failedRead = ctx.port.readFeatures();

  await Promise.allSettled([failedRead]);

  const features = await ctx.port.readFeatures();

  expect(failedRead).rejects.toMatchObject({
    code: 'UNREACHABLE',
    message: 'impd did not answer',
  });

  expect(features).toStrictEqual({
    sessionOffsets: true,
    leases: true,
    grantableTokens: true,
    secretRebind: true,
    execRequire: true,
    oauthSecrets: true,
  });
});

test('it counts each feature read that failed as an unreachable impd', async () => {
  const ctx = setupTest();

  ctx.port.setFeatureFailures(2);

  await Promise.allSettled([ctx.port.readFeatures(), ctx.port.readFeatures()]);
  await ctx.port.readFeatures();

  expect(ctx.port.countFailedFeatureReads()).toBe(2);
});

test('it exits 1 from a command whose argv holds the failing text without running it', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setCommandFailure('ran');

  const result = await ctx.port.runCommand('imp-a', {
    argv: ['touch', join(ctx.dir, 'ran')],
  });

  const ran = await Bun.file(join(ctx.dir, 'ran')).exists();

  expect({
    code: result.code,
    stdout: Buffer.from(result.stdout).toString(),
    stderr: Buffer.from(result.stderr).toString(),
  }).toStrictEqual({ code: 1, stdout: '', stderr: 'the command failed\n' });

  expect(ran).toBe(false);
});

test('it runs commands again once the command failure is cleared', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setCommandFailure('echo');

  const failed = await ctx.port.runCommand('imp-a', { argv: ['echo', 'ran'] });

  ctx.port.setCommandFailure(null);

  const result = await ctx.port.runCommand('imp-a', { argv: ['echo', 'ran'] });

  expect({
    code: failed.code,
    stdout: Buffer.from(failed.stdout).toString(),
    stderr: Buffer.from(failed.stderr).toString(),
  }).toStrictEqual({ code: 1, stdout: '', stderr: 'the command failed\n' });

  expect(Buffer.from(result.stdout).toString()).toBe('ran\n');
});

test('it refuses a command in an imp it does not hold with NOT_FOUND', () => {
  const ctx = setupTest();

  expect(ctx.port.runCommand('imp-a', { argv: ['true'] })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('it refuses a command in a sleeping imp with INVALID_STATE', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });
  await ctx.port.suspendImp('imp-a');

  expect(ctx.port.runCommand('imp-a', { argv: ['true'] })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'sleeping', allowed: ['running'] },
  });
});

test('it records every session request it sends to impd', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const request = {
    kind: 'start',
    name: 'imp-a',
    session: 's1',
    argv: ['true'],
    env: {},
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  } as const;

  const connection = ctx.port.openSession(request, { onStarted: () => {}, onOutput: () => {} });

  await connection.outcome;

  expect(ctx.port.sessionRequests).toStrictEqual([request]);
});

test('it sends nothing for a session whose gate stays closed', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['true'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
    () => false,
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'closed',
    reason: 'closed before sending',
    closeCode: 1000,
  });

  expect(ctx.port.sessionRequests).toStrictEqual([]);
});

test('it refuses a session on an imp it does not hold with NOT_FOUND', async () => {
  const ctx = setupTest();

  const connection = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'NOT_FOUND',
    message: 'no imp imp-a',
    data: { kind: 'imp', name: 'imp-a' },
  });
});

test('it drops the next session request with the close code it is given', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setSessionDrops(1, 1006);

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['touch', join(ctx.dir, 'ran')],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;
  const ran = await Bun.file(join(ctx.dir, 'ran')).exists();

  expect(outcome).toStrictEqual({ kind: 'closed', reason: 'code 1006', closeCode: 1006 });
  expect(ran).toBe(false);
});

test('it answers the session request after the dropped ones', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setSessionDrops(1, 1006);

  const dropped = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const droppedOutcome = await dropped.outcome;

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['printf', 'ran'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(droppedOutcome).toStrictEqual({ kind: 'closed', closeCode: 1006, reason: 'code 1006' });
  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 3 });
});

test('it refuses the next session request with the code and data it is given', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setNextSessionFailure('FORBIDDEN', { reason: 'scope' });

  const connection = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'FORBIDDEN',
    message: 'impd refused the session (FORBIDDEN)',
    data: { reason: 'scope' },
  });
});

test('it refuses the next session request with the message it is given', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setNextSessionFailure(null, null, 'the socket closed mid-answer');

  const connection = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: null,
    message: 'the socket closed mid-answer',
    data: null,
  });
});

test('it throws from opening the next session connections', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setOpenFailures(1);

  expect(() =>
    ctx.port.openSession(
      { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
      { onStarted: () => {}, onOutput: () => {} },
    ),
  ).toThrowWithMessage(TypeError, 'the authorization header is invalid');
});

test('it ends the next session connections unreachable without sending their request', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.setUpgradeFailures(1);

  const connection = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'unreachable', detail: 'the upgrade failed' });
  expect(ctx.port.sessionRequests).toStrictEqual([]);
});

test('it holds a session connection open without sending its request while upgrades are held', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.startUpgradeHold();

  ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  expect(ctx.port.countHeldUpgrades()).toBe(1);
  expect(ctx.port.sessionRequests).toStrictEqual([]);
});

test('it sends each held session request once the upgrade hold stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.startUpgradeHold();

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['printf', 'ran'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.countHeldUpgrades()).toBe(1);
  });

  const requestsWhileHeld = ctx.port.sessionRequests.length;

  ctx.port.stopUpgradeHold();

  const outcome = await connection.outcome;

  expect(requestsWhileHeld).toBe(0);
  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 3 });
  expect(ctx.port.countHeldUpgrades()).toBe(0);
});

test('it holds every session answer back while the answer hold lasts', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.startAnswerHold();

  const started: ImpSessionStarted[] = [];

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(ctx.port.countHeldAnswers()).toBe(1);
  });

  expect(started).toStrictEqual([]);
});

test('it sends every held answer once the answer hold stops', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.startAnswerHold();

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['printf', 'ran'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.countHeldAnswers()).toBe(1);
  });

  ctx.port.stopAnswerHold();

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 3 });
});

test('it starts an exact resume the overlap it is given before the offset asked for', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.resumeOverlap = 2;

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'printf abcdef; sleep 30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(6);
  });

  const chunks: Uint8Array[] = [];

  ctx.port.openSession(
    {
      kind: 'attach',
      name: 'imp-a',
      session: 's1',
      cols: 80,
      rows: 24,
      resumeFrom: { executionGeneration: ctx.port.getGeneration('imp-a', 's1'), offset: 4 },
      wake: false,
    },
    {
      onStarted: () => {},
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toBe('cdef');
  });
});

test('it reads the generation and boot a started session runs under', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const started: ImpSessionStarted[] = [];

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(started).toHaveLength(1);
  });

  expect(started).toStrictEqual([
    {
      created: true,
      output: {
        continuity: 'offsets',
        bootId: ctx.port.getBootID('imp-a'),
        executionGeneration: ctx.port.getGeneration('imp-a', 's1'),
        bufferStart: 0,
        end: 0,
        offset: 0,
        prelude: 0,
        coldBoots: [
          { bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() },
        ],
      },
    },
  ]);
});

test('it throws reading the generation of a session the imp does not run', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  expect(() => ctx.port.getGeneration('imp-a', 's1')).toThrowWithMessage(
    Error,
    'no session s1 on imp imp-a',
  );
});

test('it writes what a connection sends to the session process', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const chunks: Uint8Array[] = [];
  const started = Promise.withResolvers<void>();

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['cat'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {
        started.resolve();
      },
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await started.promise;

  connection.write(new TextEncoder().encode(`typed${KEYS.enter}`));

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toInclude('typed');
  });
});

test('it delivers a signal a connection sends to the session process', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const started = Promise.withResolvers<void>();

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {
        started.resolve();
      },
      onOutput: () => {},
    },
  );

  await started.promise;

  connection.sendSignal('SIGKILL');

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'exit', code: 1, signal: null, offset: 0 });
});

test('it answers a resume from another generation with the running one and data from the ring start', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'printf abc; sleep 30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(3);
  });

  opened.close();

  const started: ImpSessionStarted[] = [];
  const chunks: Uint8Array[] = [];

  ctx.port.openSession(
    {
      kind: 'attach',
      name: 'imp-a',
      session: 's1',
      cols: 80,
      rows: 24,
      resumeFrom: { executionGeneration: 'f'.repeat(32), offset: 2 },
      wake: false,
    },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toBe('abc');
  });

  expect(started).toStrictEqual([
    {
      created: false,
      output: {
        continuity: 'offsets',
        bootId: ctx.port.getBootID('imp-a'),
        executionGeneration: ctx.port.getGeneration('imp-a', 's1'),
        bufferStart: 0,
        end: 3,
        offset: 0,
        prelude: 0,
        coldBoots: [
          { bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() },
        ],
        resume: {
          kind: 'generation_changed',
          executionGeneration: ctx.port.getGeneration('imp-a', 's1'),
          firstOffset: 0,
        },
      },
    },
  ]);
});

test('it starts a fresh attach on a wrapped ring at the next line, after the mode prelude', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  // 300000 bytes of output wrap the 262144-byte ring, and the terminal
  // writes the line break as two bytes, so the run ends at offset 300006.
  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [
        'bash',
        '-c',
        String.raw`head -c 300000 /dev/zero | tr '\0' a; printf '\nTAIL'; sleep 30`,
      ],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(300_006);
  });

  const started: ImpSessionStarted[] = [];
  const chunks: Uint8Array[] = [];

  ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toBe('\u001B[0mTAIL');
  });

  expect(started).toStrictEqual([
    {
      created: false,
      output: {
        continuity: 'offsets',
        bootId: ctx.port.getBootID('imp-a'),
        executionGeneration: ctx.port.getGeneration('imp-a', 's1'),
        bufferStart: 300_006 - 262_144,
        end: 300_006,
        offset: 300_002,
        prelude: 4,
        coldBoots: [
          { bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() },
        ],
      },
    },
  ]);
});

test('it finds no undelivered exit for a session whose process still runs', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'printf up; sleep 30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(2);
  });

  expect(ctx.port.findUndeliveredExit('imp-a', 's1')).toBeNull();
});

test('it delivers an exit no connection received to the next attach, with the generation it ended', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  // The process waits for the go file, so it exits only after the start's
  // connection has closed.
  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sh', '-c', 'while [ ! -e go ]; do sleep 0.01; done; exit 3'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(0);
  });

  opened.close();

  const generation = ctx.port.getGeneration('imp-a', 's1');

  writeFileSync(join(ctx.dir, 'go'), '');

  await waitFor(() => {
    expect(ctx.port.findUndeliveredExit('imp-a', 's1')).toStrictEqual({ code: 3 });
  });

  const started: ImpSessionStarted[] = [];

  const attached = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  const outcome = await attached.outcome;

  expect(started).toStrictEqual([
    {
      created: false,
      output: {
        continuity: 'offsets',
        bootId: ctx.port.getBootID('imp-a'),
        executionGeneration: generation,
        bufferStart: 0,
        end: 0,
        offset: 0,
        prelude: 0,
        coldBoots: [
          { bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() },
        ],
        previous: { executionGeneration: generation, end: 0, exitCode: 3 },
      },
    },
  ]);

  expect(outcome).toStrictEqual({ kind: 'exit', code: 3, signal: null, offset: 0 });
});

test('it answers an attach after the exit was delivered with NO_SESSION and the generation that ended', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  // The process waits for the go file, so it exits only after the start's
  // connection has closed.
  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sh', '-c', 'while [ ! -e go ]; do sleep 0.01; done; exit 3'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(0);
  });

  opened.close();

  const generation = ctx.port.getGeneration('imp-a', 's1');

  writeFileSync(join(ctx.dir, 'go'), '');

  await waitFor(() => {
    expect(ctx.port.findUndeliveredExit('imp-a', 's1')).toStrictEqual({ code: 3 });
  });

  await ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  ).outcome;

  const attached = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await attached.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'NO_SESSION',
    message: 'no session s1',
    data: {
      bootId: ctx.port.getBootID('imp-a'),
      coldBoots: [{ bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() }],
      previous: { executionGeneration: generation, end: 0, exitCode: 3 },
    },
  });
});

test('it resizes the terminal of the session a connection holds', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const chunks: Uint8Array[] = [];

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'trap "stty size" WINCH; printf ready; while :; do sleep 0.05; done'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {},
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toBe('ready');
  });

  connection.resize(100, 30);

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toBe('ready30 100\r\n');
  });
});

test('it runs a start that requires the broker once a broker failure stops', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity(buildMockImpIdentity({ grantable: ['glm'] }));

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.startBrokerFailure();

  const refused = ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's0',
      argv: ['printf', 'ran'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const refusedOutcome = await refused.outcome;

  ctx.port.stopBrokerFailure();

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'atc-s1',
      session: 's1',
      argv: ['printf', 'ran'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(refusedOutcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready in imp atc-s1',
    data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
  });

  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 3 });
});

test('it sends nothing for a session whose gate throws', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['true'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
    () => {
      throw new Error('the gate broke');
    },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'closed',
    reason: 'closed before sending',
    closeCode: 1000,
  });

  expect(ctx.port.sessionRequests).toStrictEqual([]);
});

test('it starts a session with a relative working directory under the guest home once the test gives one', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  mkdirSync(join(ctx.dir, 'work'));

  ctx.port.setHomeDir(ctx.dir);

  const chunks: Uint8Array[] = [];

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['pwd'],
      env: {},
      cwd: 'work',
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {},
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await connection.outcome;

  expect(Buffer.concat(chunks).toString()).toBe(`${join(ctx.dir, 'work')}\r\n`);
});

test('it finds no undelivered exit once an attach has delivered it', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  // The process waits for the go file, so it exits only after the start's
  // connection has closed.
  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sh', '-c', 'while [ ! -e go ]; do sleep 0.01; done; exit 3'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1')).toBe(0);
  });

  opened.close();

  writeFileSync(join(ctx.dir, 'go'), '');

  await waitFor(() => {
    expect(ctx.port.findUndeliveredExit('imp-a', 's1')).toStrictEqual({ code: 3 });
  });

  await ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  ).outcome;

  expect(ctx.port.findUndeliveredExit('imp-a', 's1')).toBeNull();
});

test('it finds no undelivered exit for a session the imp does not hold', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  expect(ctx.port.findUndeliveredExit('imp-a', 's-unknown')).toBeNull();
});

test('it records the spec of each imp it is asked to create, in order', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a', image: 'base', memoryMib: 512 });
  await ctx.port.createImp({ name: 'imp-b' });

  expect(ctx.port.createSpecs).toStrictEqual([
    { name: 'imp-a', image: 'base', memoryMib: 512 },
    { name: 'imp-b' },
  ]);
});

test('it detaches a live connection as lost and stops its process when the imp sleeps', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const chunks: Uint8Array[] = [];

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'echo $$; exec sleep 30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {},
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toMatch(/^\d+\r\n$/);
  });

  const pid = Buffer.concat(chunks).toString().trim();
  const end = ctx.port.getEnd('imp-a', 's1');

  await ctx.port.suspendImp('imp-a');

  const outcome = await connection.outcome;

  await waitFor(async () => {
    const ps = await runCommand(['ps', '-o', 'state=', '-p', pid]);

    expect(ps.stdout).toStartWith('T');
  });

  expect(outcome).toStrictEqual({ kind: 'detached', reason: 'lost', offset: end });
});

test('it continues a stopped process under the same generation when the imp wakes from memory', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const chunks: Uint8Array[] = [];

  const opened = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'echo $$; exec sleep 30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {},
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toMatch(/^\d+\r\n$/);
  });

  const pid = Buffer.concat(chunks).toString().trim();
  const generation = ctx.port.getGeneration('imp-a', 's1');

  await ctx.port.suspendImp('imp-a');

  await opened.outcome;

  await waitFor(async () => {
    const ps = await runCommand(['ps', '-o', 'state=', '-p', pid]);

    expect(ps.stdout).toStartWith('T');
  });

  const started: ImpSessionStarted[] = [];

  ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    {
      onStarted: (s) => {
        started.push(s);
      },
      onOutput: () => {},
    },
  );

  await waitFor(() => {
    expect(started).toHaveLength(1);
  });

  await waitFor(async () => {
    const ps = await runCommand(['ps', '-o', 'state=', '-p', pid]);

    expect(ps.stdout).toStartWith('S');
  });

  expect(started).toStrictEqual([
    {
      created: false,
      output: {
        continuity: 'offsets',
        bootId: ctx.port.getBootID('imp-a'),
        executionGeneration: generation,
        bufferStart: 0,
        end: Buffer.concat(chunks).length,
        offset: 0,
        prelude: 0,
        coldBoots: [
          { bootId: ctx.port.getBootID('imp-a'), cause: 'start', at: expect.toBeString() },
        ],
      },
    },
  ]);

  expect(ctx.port.getGeneration('imp-a', 's1')).toBe(generation);
});

test('it closes a live connection and kills its process when the imp is destroyed', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const chunks: Uint8Array[] = [];

  const connection = ctx.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'echo $$; exec sleep 30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      onStarted: () => {},
      onOutput: (d) => {
        chunks.push(d);
      },
    },
  );

  await waitFor(() => {
    expect(Buffer.concat(chunks).toString()).toMatch(/^\d+\r\n$/);
  });

  const pid = Buffer.concat(chunks).toString().trim();

  await ctx.port.destroyImp('imp-a');

  const outcome = await connection.outcome;

  await waitFor(() => {
    expect(isProcessAlive(Number(pid))).toBeFalse();
  });

  expect(outcome).toStrictEqual({ kind: 'closed', reason: 'imp destroyed', closeCode: 1000 });
});

test('it owns a lease under the principal it was created with', async () => {
  const port = createStubImpPort('token:ci');

  await port.createImp({ name: 'imp-a' });

  const lease = await port.acquireLease('imp-a', 'atc-d1', 60);

  expect(lease.owner).toStrictEqual({
    principal: 'token:ci',
    display: 'token:ci',
    label: 'atc-d1',
  });
});

test('it stops every forward once the test finishes without a stop', () => {
  // The directory registers first, so its removal runs after the check
  // below and only the forward's own stop can take the socket away first.
  const tmp = setupTempDir('atc-stub-imp-port-');
  const guestPath = join(tmp.dir, 'guest.sock');
  let left: boolean | null = null;

  // Runs after the port's own release, which registers later; it records
  // whether that release left the socket.
  registerTestCleanup(() => {
    left = existsSync(guestPath);
  });

  const port = createStubImpPort();

  port.openReverseForward('imp-a', guestPath, () => {});

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});

test('it stops every forward once stopped', async () => {
  const ctx = setupTest();
  const guestPath = join(ctx.dir, 'guest.sock');

  ctx.port.openReverseForward('imp-a', guestPath, () => {});

  await ctx.port.stop();

  expect(existsSync(guestPath)).toBeFalse();
});
