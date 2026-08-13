import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { DaemonClient } from '../src/daemon-client';
import type { EventMsg } from '../src/protocol';
import { isRecord } from '../src/report';

const repo = dirname(import.meta.dir);

function getRecord(value: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const inner = value[key];

  if (!isRecord(inner)) {
    throw new TypeError(`${key} is not an object`);
  }

  return inner;
}

function getString(value: Readonly<Record<string, unknown>>, key: string): string {
  const inner = value[key];

  if (typeof inner !== 'string') {
    throw new TypeError(`${key} is not a string`);
  }

  return inner;
}

function getRecords(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown>[] {
  const inner = value[key];

  if (!Array.isArray(inner)) {
    throw new TypeError(`${key} is not an array`);
  }

  return inner.filter((item) => isRecord(item));
}

interface DaemonContext {
  readonly home: string;
  readonly daemonSock: string;
  readonly proc: Subprocess;
  readonly openClient: () => Promise<DaemonClient>;
}

function collectEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

function setupDaemonProc(
  home?: string,
  extraEnv?: Readonly<Record<string, string>>,
): DaemonContext {
  const freshHome = home ?? mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  if (home === undefined) {
    mkdirSync(join(freshHome, '.config', 'atc'), { recursive: true });
    mkdirSync(join(freshHome, '.local', 'state', 'atc'), { recursive: true });

    const fakeClaude = join(freshHome, 'fake-claude');

    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
while read -r line; do echo "GOT:$line"; done
sleep 30
`,
      { mode: 0o755 },
    );

    writeFileSync(
      join(freshHome, '.config', 'atc', 'config.json'),
      JSON.stringify({ claudeBin: fakeClaude, claudeArgs: [] }),
    );
  }

  const proc = Bun.spawn([process.execPath, join(repo, 'src', 'cli.ts'), 'daemon'], {
    env: collectEnv({
      HOME: freshHome,
      XDG_RUNTIME_DIR: freshHome,
      PATH: '/usr/sbin:/usr/bin:/bin',
      ...extraEnv,
    }),
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const daemonSock = join(freshHome, 'atc-daemon.sock');
  const clients: DaemonClient[] = [];

  const openClient = async () => {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      try {
        const client = await DaemonClient.open(daemonSock);

        clients.push(client);

        return client;
      } catch {
        await Bun.sleep(50);
      }
    }

    throw new Error('daemon socket never came up');
  };

  onTestFinished(() => {
    for (const client of clients) {
      client.stop();
    }

    proc.kill();

    if (home === undefined) {
      rmSync(freshHome, { recursive: true, force: true });
    }
  });

  return { home: freshHome, daemonSock, proc, openClient };
}

async function waitForEvent(
  events: readonly EventMsg[],
  matches: (e: EventMsg) => boolean,
  ms = 5000,
): Promise<EventMsg> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const found = events.find((e) => matches(e));

    if (found !== undefined) {
      return found;
    }

    await Bun.sleep(20);
  }

  throw new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.ev))}`);
}

test('it spawns a session and broadcasts session.added to every client', async () => {
  const ctx = setupDaemonProc();

  const watcher = await ctx.openClient();

  const events: EventMsg[] = [];

  watcher.onEvent = (e) => {
    events.push(e);
  };

  await watcher.sendHello('atc/test');

  const actor = await ctx.openClient();

  await actor.sendHello('atc/test');

  const ok = await actor.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  expect(ok).toStrictEqual({
    session: expect.toSatisfy(
      (s: Readonly<Record<string, unknown>>) => s['kind'] === 'pty' && s['alive'] === true,
    ),
  });

  const added = await waitForEvent(events, (e) => e.ev === 'session.added');

  expect(added['session']).toMatchObject({ cwd: ctx.home, state: 'running' });
});

test('it turns hook notifications into session.state broadcasts', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);

  expect(sessions[0]).toMatchObject({
    state: 'needs_you',
    lastMsg: 'needs permission',
    claudeId: 'fake-1',
  });
});

test('it keeps a live terminal alive when its session reports an end', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  const reporter = Bun.spawn([process.execPath, join(repo, 'src', 'cli.ts'), 'hook-report'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fake-1' }),
    ),
    env: collectEnv({
      HOME: ctx.home,
      ATC_SESSION_ID: id,
      ATC_SOCKET: join(ctx.home, 'atc.sock'),
    }),
  });

  await reporter.exited;

  const ended = await waitForEvent(
    events,
    (e) => e.ev === 'session.state' && e['lastMsg'] === 'session ended',
  );

  expect(ended).toMatchObject({ alive: true, kind: 'pty', state: 'needs_you' });

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions[0]).toMatchObject({ alive: true, state: 'needs_you', lastMsg: 'session ended' });
});

test('it kills a live session to exited and a dead one to removed', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['lastMsg'] === 'killed');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, (e) => e.ev === 'session.removed' && e['s'] === id);

  const list = await client.sendRequest('session.list');

  expect(list).toStrictEqual({ sessions: [] });
});

test('it builds a resume command once the claude id is captured', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  const command = getString(answer, 'command');

  expect(command).toInclude('claude --resume fake-1');
  expect(command).toStartWith("cd '");
});

test('it restores the fleet cold after a daemon crash', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  ctx.proc.kill(9);

  await ctx.proc.exited;

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  await client2.sendHello('atc/test');

  const restored = await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({ restored: 1 });

  const list = await client2.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ claudeId: 'fake-1', alive: true });
});

test('it broadcasts permission.requested when a session needs input', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const requested = await waitForEvent(events, (e) => e.ev === 'permission.requested');

  expect(requested).toMatchObject({
    message: 'needs permission',
    respondable: false,
    request: expect.toBeString() as string,
  });
});

test('it answers permission.respond on a keystroke-only request with unsupported', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const requested = await waitForEvent(events, (e) => e.ev === 'permission.requested');

  const request = getString(requested, 'request');

  expect(
    client.sendRequest('permission.respond', { request, decision: 'allow' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it resolves a pending permission request as dismissed when the session dies', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  const requested = await waitForEvent(events, (e) => e.ev === 'permission.requested');

  const request = getString(requested, 'request');

  await client.sendRequest('session.kill', { session: id });

  const resolved = await waitForEvent(
    events,
    (e) => e.ev === 'permission.resolved' && e['request'] === request,
  );

  expect(resolved['decision']).toBe('dismissed');
});

test('it streams pty output to an attached client with increasing seq', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  const attached = await client.sendRequest('session.attach', {
    session: id,
    cols: 100,
    rows: 30,
  });

  expect(attached).toStrictEqual({ cols: 100, rows: 30 });

  await client.sendRequest('session.input', { session: id, d: 'hello\n' });

  await waitForEvent(
    events,
    (e) => e.ev === 'session.output' && String(e['d']).includes('GOT:hello'),
  );

  const seqs = events.filter((e) => e.ev === 'session.output').map((e) => Number(e['seq']));

  expect(seqs).toStrictEqual(seqs.toSorted((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
});

test('it stops streaming to a detached client while others keep receiving', async () => {
  const ctx = setupDaemonProc();

  const watcher = await ctx.openClient();
  const leaver = await ctx.openClient();

  const watcherEvents: EventMsg[] = [];
  const leaverEvents: EventMsg[] = [];

  watcher.onEvent = (e) => {
    watcherEvents.push(e);
  };

  leaver.onEvent = (e) => {
    leaverEvents.push(e);
  };

  await watcher.sendHello('atc/test');
  await leaver.sendHello('atc/test');

  const ok = await watcher.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await watcher.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await leaver.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await leaver.sendRequest('session.detach', { session: id });
  await watcher.sendRequest('session.input', { session: id, d: 'ping\n' });

  await waitForEvent(
    watcherEvents,
    (e) => e.ev === 'session.output' && String(e['d']).includes('GOT:ping'),
  );

  const leaked = leaverEvents.filter(
    (e) => e.ev === 'session.output' && String(e['d']).includes('GOT:ping'),
  );

  expect(leaked).toStrictEqual([]);
});

test('it resizes the pty to the smallest dims across attached clients', async () => {
  const ctx = setupDaemonProc();

  const wide = await ctx.openClient();
  const narrow = await ctx.openClient();

  const events: EventMsg[] = [];

  wide.onEvent = (e) => {
    events.push(e);
  };

  await wide.sendHello('atc/test');
  await narrow.sendHello('atc/test');

  const ok = await wide.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await wide.sendRequest('session.attach', { session: id, cols: 120, rows: 40 });

  await waitForEvent(events, (e) => e.ev === 'session.resized' && e['cols'] === 120);

  await narrow.sendRequest('session.attach', { session: id, cols: 90, rows: 28 });

  const shrunk = await waitForEvent(events, (e) => e.ev === 'session.resized' && e['cols'] === 90);

  expect(shrunk).toMatchObject({ s: id, cols: 90, rows: 28 });
});

test('it answers session.input on a dead session with session_dead', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['lastMsg'] === 'killed');

  expect(client.sendRequest('session.input', { session: id, d: 'x' })).rejects.toMatchObject({
    code: 'session_dead',
  });
});

test('it answers session.attach on a dead session with session_dead', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['lastMsg'] === 'killed');

  expect(
    client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it drops a slow client to desync and reports the dropped bytes', async () => {
  // A 64 KiB queue makes one echo burst overflow regardless of how much the
  // host's socket buffers absorb.
  const ctx = setupDaemonProc(undefined, { ATC_QUEUE_BYTES: '65536' });

  const driver = await ctx.openClient();

  await driver.sendHello('atc/test');

  const ok = await driver.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  // A raw slow reader: handshakes, attaches, then stops reading so the
  // daemon's outbound queue for it can only overflow.
  const net = await import('node:net');

  const slow = net.connect(ctx.daemonSock);

  onTestFinished(() => {
    slow.destroy();
  });

  await new Promise<void>((resolve) => {
    slow.once('connect', () => {
      resolve();
    });
  });

  let received = '';

  slow.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });

  slow.write('{"v":1,"id":1,"m":"daemon.hello","p":{"client":"atc/slow"}}\n');

  const deadline = Date.now() + 5000;

  while (!received.includes('"id":1') && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  slow.write(`{"v":1,"id":2,"m":"session.attach","p":{"session":"${id}","cols":80,"rows":24}}\n`);

  while (!received.includes('"id":2') && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  slow.pause();

  // The pty line discipline caps a canonical-mode line at 4095 bytes, so
  // the flood is many short lines; each echoes back at roughly double its
  // size. How much the host's socket and stream buffers absorb before the
  // daemon's queue overflows varies by kernel, so bursts repeat until the
  // desync lands instead of trusting any fixed volume.
  const line = 'x'.repeat(3000);
  const burst = `${line}\n`.repeat(300);
  const desyncDeadline = Date.now() + 15_000;

  while (!received.includes('session.desync') && Date.now() < desyncDeadline) {
    await driver.sendRequest('session.input', { session: id, d: burst });
    await Bun.sleep(300);

    slow.resume();

    await Bun.sleep(50);

    slow.pause();
  }

  slow.resume();

  while (!received.includes('session.desync') && Date.now() < desyncDeadline) {
    await Bun.sleep(50);
  }

  const desyncLine = received.split('\n').find((raw) => raw.includes('session.desync'));

  if (desyncLine === undefined) {
    throw new Error('no session.desync event arrived');
  }

  expect(JSON.parse(desyncLine)).toMatchObject({
    ev: 'session.desync',
    s: id,
    dropped: expect.toBePositive() as number,
  });
}, 20_000);
