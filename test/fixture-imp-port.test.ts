import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ImpSessionStarted } from '../src/daemon/imp-port';
import { FixtureImpPort } from './fixture-imp-port';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-fixture-imp-');

  const port = new FixtureImpPort();

  return {
    port,
    dir: tmp.dir,
    [Symbol.dispose]() {
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it refuses a lease under the label hold', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  expect(fixture.port.acquireLease('imp-a', 'hold', 60)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses to sleep a leased imp with the leases it shows and a count of the rest', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });
  await fixture.port.acquireLease('imp-a', 'atc-d1', 60);

  fixture.port.acquireOtherLease('imp-a', 'token:other', 'build', 60);

  expect(fixture.port.suspendImp('imp-a')).rejects.toMatchObject({
    code: 'LEASED',
    data: {
      leases: [{ owner: { label: 'atc-d1' } }],
      otherCount: 1,
    },
  });
});

test('it sleeps an imp once the caller released its own lease', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });
  await fixture.port.acquireLease('imp-a', 'atc-d1', 60);
  await fixture.port.releaseLease('imp-a', 'atc-d1');
  await fixture.port.suspendImp('imp-a');

  expect(fixture.port.findState('imp-a')).toBe('sleeping');
});

test('it refuses a renewal of a lease a forced sleep ended', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });
  await fixture.port.acquireLease('imp-a', 'atc-d1', 60);

  fixture.port.suspendWithForce('imp-a');

  expect(fixture.port.renewLease('imp-a', 'atc-d1', 60)).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it streams a started session with offsets and delivers its exit with the end', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const started: ImpSessionStarted[] = [];
  const chunks: Uint8Array[] = [];

  const connection = fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['printf', 'hello'],
      env: {},
      cwd: fixture.dir,
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
        bootId: expect.toBeString(),
        executionGeneration: expect.toSatisfy((value: string) => /^[0-9a-f]{32}$/.test(value)),
        bufferStart: 0,
        end: 0,
        offset: 0,
        prelude: 0,
        coldBoots: [expect.objectContaining({ cause: 'start' })],
      },
    },
  ]);

  expect(Buffer.concat(chunks).toString()).toBe('hello');
  expect(outcome).toStrictEqual({ kind: 'exit', code: 0, signal: null, offset: 5 });
});

test('it resumes a running generation from the exact offset asked for', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const first: ImpSessionStarted[] = [];

  const opened = fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'printf abcdef; sleep 30'],
      env: {},
      cwd: fixture.dir,
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
    expect(fixture.port.getEnd('imp-a', 's1')).toBe(6);
  });

  opened.close();

  const output = first[0]?.output;

  if (output?.continuity !== 'offsets') {
    throw new Error('the start carried no offsets');
  }

  const started: ImpSessionStarted[] = [];
  const chunks: Uint8Array[] = [];

  fixture.port.openSession(
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

  expect(started[0]?.output).toMatchObject({ offset: 4, prelude: 0, resume: { kind: 'exact' } });
});

test('it answers a resume below the ring with a gap and data from the ring start', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const first: ImpSessionStarted[] = [];

  const opened = fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', String.raw`head -c 300000 /dev/zero | tr '\0' x; sleep 30`],
      env: {},
      cwd: fixture.dir,
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
    expect(fixture.port.getEnd('imp-a', 's1')).toBe(300_000);
  });

  opened.close();

  const output = first[0]?.output;

  if (output?.continuity !== 'offsets') {
    throw new Error('the start carried no offsets');
  }

  const started: ImpSessionStarted[] = [];

  fixture.port.openSession(
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
    expect(started[0]?.output).toMatchObject({
      bufferStart: 300_000 - 262_144,
      offset: 300_000 - 262_144,
      resume: { kind: 'gap', from: 0, to: 300_000 - 262_144 },
    });
  });
});

test('it refuses a resume past the end with INVALID_RESUME', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const first: ImpSessionStarted[] = [];

  fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: fixture.dir,
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

  if (output?.continuity !== 'offsets') {
    throw new Error('the start carried no offsets');
  }

  const resumed = fixture.port.openSession(
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
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });
  await fixture.port.suspendImp('imp-a');

  const attached = fixture.port.openSession(
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
      coldBoots: [expect.objectContaining({ cause: 'start' })],
    },
  });

  expect(fixture.port.findState('imp-a')).toBe('sleeping');
});

test('it answers an attach after a cold boot with NO_SESSION and the boot that ended it', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: fixture.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(fixture.port.getEnd('imp-a', 's1')).toBe(0);
  });

  fixture.port.bootImpCold('imp-a', 'wake_fallback');

  const attached = fixture.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const ended = await attached.outcome;

  expect(ended).toStrictEqual({
    kind: 'failed',
    code: 'NO_SESSION',
    message: expect.toBeString(),
    data: {
      bootId: expect.toBeString(),
      coldBoots: [
        expect.objectContaining({ cause: 'wake_fallback' }),
        expect.objectContaining({ cause: 'start' }),
      ],
    },
  });
});

test('it keeps the last four cold boots, newest first', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  for (const cause of ['watchdog', 'restore', 'recovery', 'wake_fallback'] as const) {
    fixture.port.bootImpCold('imp-a', cause);
  }

  const started: ImpSessionStarted[] = [];

  fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: fixture.dir,
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
    expect(started[0]?.output).toMatchObject({
      coldBoots: [
        expect.objectContaining({ cause: 'wake_fallback' }),
        expect.objectContaining({ cause: 'recovery' }),
        expect.objectContaining({ cause: 'restore' }),
        expect.objectContaining({ cause: 'watchdog' }),
      ],
    });
  });
});

test('it replays without offsets and ignores a resume for an agent without continuity', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  fixture.port.continuity = 'none';

  const started: ImpSessionStarted[] = [];

  fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: fixture.dir,
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
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const opened = fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: fixture.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(fixture.port.getEnd('imp-a', 's1')).toBe(0);
  });

  fixture.port.stopConnection('imp-a', 's1', 1011);

  const ended = await opened.outcome;

  expect(ended).toStrictEqual({
    kind: 'closed',
    reason: 'code 1011',
    closeCode: 1011,
  });
});

test('it ends a connection whose output handler throws with a local error and keeps the process', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const opened = fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['bash', '-c', 'echo hi; sleep 30'],
      env: {},
      cwd: fixture.dir,
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

  expect(ended).toStrictEqual({ kind: 'local_error', detail: 'write EPIPE' });
  expect(fixture.port.getEnd('imp-a', 's1')).toBeGreaterThan(0);
});

test('it detaches the earlier connection when a second one attaches', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const opened = fixture.port.openSession(
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: ['sleep', '30'],
      env: {},
      cwd: fixture.dir,
      cols: 80,
      rows: 24,
    },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await waitFor(() => {
    expect(fixture.port.getEnd('imp-a', 's1')).toBe(0);
  });

  fixture.port.openSession(
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
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const received: string[] = [];
  const guestPath = join(fixture.dir, 'guest.sock');

  fixture.port.openReverseForward('imp-a', guestPath, (connection) => {
    connection.onData((data) => {
      received.push(Buffer.from(data).toString());
    });
  });

  const socket = await Bun.connect({ unix: guestPath, socket: { data() {} } });

  socket.write('report\n');
  socket.end();

  await waitFor(() => {
    expect(received.join('')).toBe('report\n');
  });
});

test('it writes every byte the daemon sends to the guest end of a relayed connection', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const guestPath = join(fixture.dir, 'guest.sock');

  const sent = new Uint8Array(4 * 1024 * 1024).fill(97);

  let received = 0;

  fixture.port.openReverseForward('imp-a', guestPath, (connection) => {
    void connection.write(sent);
  });

  await Bun.connect({
    unix: guestPath,
    socket: {
      data(_socket, buf) {
        received += buf.length;
      },
    },
  });

  await waitFor(() => {
    expect(received).toBe(sent.length);
  });
});

test('it closes every guest connection on its forwards and keeps listening for the next', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const guestPath = join(fixture.dir, 'guest.sock');
  let connections = 0;
  const closed = Promise.withResolvers<void>();

  fixture.port.openReverseForward('imp-a', guestPath, () => {
    connections += 1;
  });

  await Bun.connect({
    unix: guestPath,
    socket: {
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  await waitFor(() => {
    expect(connections).toBe(1);
  });

  fixture.port.stopRelays();

  await closed.promise;

  await Bun.connect({ unix: guestPath, socket: { data() {} } });

  await waitFor(() => {
    expect(connections).toBe(2);
  });
});

test('it closes each new guest connection without relaying it while relays are refused', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const guestPath = join(fixture.dir, 'guest.sock');
  let connections = 0;
  const closed = Promise.withResolvers<void>();

  fixture.port.openReverseForward('imp-a', guestPath, () => {
    connections += 1;
  });

  fixture.port.startRelayRefusal();

  await Bun.connect({
    unix: guestPath,
    socket: {
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  await closed.promise;

  expect(connections).toBe(0);
});

test('it relays guest connections again once the refusal stops', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const guestPath = join(fixture.dir, 'guest.sock');
  let connections = 0;

  fixture.port.openReverseForward('imp-a', guestPath, () => {
    connections += 1;
  });

  fixture.port.startRelayRefusal();
  fixture.port.stopRelayRefusal();

  await Bun.connect({ unix: guestPath, socket: { data() {} } });

  await waitFor(() => {
    expect(connections).toBe(1);
  });
});

test('it drops what a guest writes while guest bytes are dropped', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const received: string[] = [];
  const guestPath = join(fixture.dir, 'guest.sock');

  fixture.port.openReverseForward('imp-a', guestPath, (connection) => {
    connection.onData((data) => {
      received.push(Buffer.from(data).toString());
    });
  });

  fixture.port.startGuestByteDrop();

  const socket = await Bun.connect({ unix: guestPath, socket: { data() {} } });

  socket.write('lost\n');

  // No signal marks a dropped write, so the wait gives it time to arrive.
  await Bun.sleep(100);

  fixture.port.stopGuestByteDrop();
  socket.write('kept\n');

  await waitFor(() => {
    expect(received.join('')).toBe('kept\n');
  });
});

test('it runs a command in a running imp with the input it is given', async () => {
  using fixture = setupTest();

  await fixture.port.createImp({ name: 'imp-a' });

  const result = await fixture.port.runCommand('imp-a', {
    argv: ['cat'],
    stdin: new TextEncoder().encode('piped'),
  });

  expect({ ...result, stdout: Buffer.from(result.stdout).toString() }).toStrictEqual({
    code: 0,
    stdout: 'piped',
    stderr: new Uint8Array(0),
  });
});
