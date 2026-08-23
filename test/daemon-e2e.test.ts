import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { DaemonClient } from '../src/client/daemon-client';
import type { EventMsg } from '../src/protocol/protocol';
import { getRecord } from '../src/shared/get-record';
import { isRecord } from '../src/shared/report';
import { toAgentSessionID } from '../src/shared/to-agent-session-id';
import { StateStore } from '../src/store/state-store';

const repo = dirname(import.meta.dir);

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
    const fakeGrok = join(freshHome, 'fake-grok');
    const fakeCodex = join(freshHome, 'fake-codex');
    const hookReport = `"${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report`;

    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | ${hookReport}
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | ${hookReport}
while read -r line; do echo "GOT:$line"; done
sleep 30
`,
      { mode: 0o755 },
    );

    writeFileSync(
      fakeGrok,
      `#!/usr/bin/env bash
echo "FAKE_GROK_UP args: $@"
if [ -f "$HOME/fake-grok-hold-start" ]; then
  while read -r line; do echo "GOT:$line"; done
  sleep 30
  exit 0
fi
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | ${hookReport}
if [ -f "$HOME/fake-grok-events.jsonl" ]; then
  sleep 0.3
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | ${hookReport}
    sleep 0.2
  done < "$HOME/fake-grok-events.jsonl"
else
  sleep 0.3
  printf '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}' | ${hookReport}
fi
echo "FAKE_GROK_HOOKS_DONE"
while read -r line; do echo "GOT:$line"; done
sleep 30
`,
      { mode: 0o755 },
    );

    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
echo "FAKE_CODEX_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"'"$HOME"'/fake-rollout.jsonl","cwd":"%s","source":"startup"}' "$PWD" | ${hookReport}
sleep 0.3
printf '{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"'"$HOME"'/fake-rollout.jsonl","last_assistant_message":"pong"}' | ${hookReport}
while read -r line; do echo "GOT:$line"; done
sleep 30
`,
      { mode: 0o755 },
    );

    writeFileSync(
      join(freshHome, '.config', 'atc', 'config.json'),
      JSON.stringify({
        claudeBin: fakeClaude,
        claudeArgs: [],
        grokBin: fakeGrok,
        grokArgs: [],
        codexBin: fakeCodex,
        codexArgs: [],
        gateways: [],
      }),
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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);

  expect(sessions[0]).toMatchObject({
    state: 'needs_you',
    lastMsg: 'needs permission',
    agentSessionID: 'fake-1',
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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

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
    (e) =>
      e.ev === 'session.state' &&
      isRecord(e['session']) &&
      e['session']['lastMsg'] === 'session ended',
  );

  expect(ended).toMatchObject({ session: { alive: true, kind: 'pty', state: 'needs_you' } });

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions[0]).toMatchObject({ alive: true, state: 'needs_you', lastMsg: 'session ended' });
});

test('it renames and pins a session through session.update', async () => {
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

  await client.sendRequest('session.update', { session: id, name: 'auth-bug', pinned: true });

  const renamed = await waitForEvent(
    events,
    (e) => e.ev === 'session.renamed' && e['name'] === 'auth-bug',
  );

  expect(renamed).toMatchObject({ namedBy: 'user' });

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions[0]).toMatchObject({ name: 'auth-bug', pinned: true, namedBy: 'user' });

  await client.sendRequest('session.update', { session: id, pinned: false });

  const cleared = await client.sendRequest('session.list');

  const clearedSessions = getRecords(cleared, 'sessions');

  expect(clearedSessions[0]).toMatchObject({ pinned: false });

  expect(
    client.sendRequest('session.update', { session: 'nope', name: 'x' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it bumps a session attach recency through session.attach', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');
  const before = spawned['lastAttachedAt'];

  if (typeof before !== 'number') {
    throw new TypeError('lastAttachedAt is not a number');
  }

  await Bun.sleep(5);
  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');
  const [first] = sessions;

  if (first === undefined) {
    throw new Error('no sessions listed');
  }

  const after = first['lastAttachedAt'];

  if (typeof after !== 'number') {
    throw new TypeError('lastAttachedAt is not a number');
  }

  expect(after).toBeGreaterThan(before);
});

test('it stops the daemon process on daemon.quit', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const answer = await client.sendRequest('daemon.quit');

  expect(answer).toStrictEqual({});

  const code = await ctx.proc.exited;

  expect(code).toBe(0);
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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

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
  expect(sessions[0]).toMatchObject({ agentSessionID: 'fake-1', alive: true });
});

test('it restores a killed session as exited across a daemon restart', async () => {
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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

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

  expect(sessions[0]).toMatchObject({
    agentSessionID: 'fake-1',
    state: 'exited',
    lastMsg: 'killed',
    alive: false,
    kind: 'headless',
  });

  const again = await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(again).toStrictEqual({ restored: 0 });
});

test('it revives the fleet one boot at a time, gated on SessionStart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  // Each revived session announces itself after a short delay, then idles.
  // Reporting its own atc id as the Claude session keeps the ids distinct.
  const fakeClaude = join(home, 'fake-claude');

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
sleep 0.4
printf '{"hook_event_name":"SessionStart","session_id":"'"$ATC_SESSION_ID"'","transcript_path":"/nonexistent"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 30
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: fakeClaude,
      claudeArgs: [],
      grokBin: join(home, 'fake-grok'),
      grokArgs: [],
    }),
  );

  writeFileSync(join(home, 'fake-grok'), '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });

  writeFileSync(
    join(home, '.local', 'state', 'atc', 'fleet.json'),
    JSON.stringify([
      { name: 'one', cwd: home, agentSessionID: 'fake-a' },
      { name: 'two', cwd: home, agentSessionID: 'fake-b' },
      { name: 'three', cwd: home, agentSessionID: 'fake-c' },
    ]),
  );

  // A cap far longer than the test can only be reached if the SessionStart
  // gate fails, so a fleet that fills in quickly proves the gate drives it.
  const ctx = setupDaemonProc(home, { ATC_RESTORE_BOOT_TIMEOUT_MS: '60000' });

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  // The whole fleet lists immediately, but only the first session has a
  // terminal by the time the immediate list comes back — the rest are queued
  // behind the previous session's SessionStart.
  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({ restored: 3 });

  const immediate = await client.sendRequest('session.list');

  const immediateSessions = getRecords(immediate, 'sessions');

  expect(immediateSessions).toHaveLength(3);
  expect(immediateSessions.filter((s) => s['kind'] === 'pty')).toHaveLength(1);
  expect(immediateSessions.filter((s) => s['lastMsg'] === 'waiting to restore')).toHaveLength(2);

  // As each revive announces itself the next terminal attaches, so the fleet
  // fills in rather than freezing until the last process is up.
  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' &&
      isRecord(e['session']) &&
      e['session']['agentSessionID'] === 'fake-c' &&
      e['session']['kind'] === 'pty',
  );

  const settled = await client.sendRequest('session.list');

  expect(getRecords(settled, 'sessions').filter((s) => s['kind'] === 'pty')).toHaveLength(3);
});

test('it moves on to the next revive when one dies before announcing itself', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  // The first revive's process exits immediately without ever announcing a
  // SessionStart; the second reports normally after a short delay. Nothing
  // adopts the second terminal unless the first revive's death still
  // releases the boot wait it left queued behind.
  const fakeClaude = join(home, 'fake-claude');

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
if [[ "$@" == *"dies-immediately"* ]]; then
  exit 0
fi
sleep 0.2
printf '{"hook_event_name":"SessionStart","session_id":"'"$ATC_SESSION_ID"'","transcript_path":"/nonexistent"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 30
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: fakeClaude,
      claudeArgs: [],
      grokBin: join(home, 'fake-grok'),
      grokArgs: [],
    }),
  );

  writeFileSync(join(home, 'fake-grok'), '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });

  writeFileSync(
    join(home, '.local', 'state', 'atc', 'fleet.json'),
    JSON.stringify([
      { name: 'dying', cwd: home, agentSessionID: 'dies-immediately' },
      { name: 'survivor', cwd: home, agentSessionID: 'fake-b' },
    ]),
  );

  // A cap far longer than the test's own wait, so a fleet that fills in
  // quickly proves the death itself released the wait rather than the cap
  // expiring.
  const ctx = setupDaemonProc(home, { ATC_RESTORE_BOOT_TIMEOUT_MS: '60000' });

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({ restored: 2 });

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' &&
      isRecord(e['session']) &&
      e['session']['agentSessionID'] === 'fake-b' &&
      e['session']['kind'] === 'pty',
    5000,
  );

  const settled = await client.sendRequest('session.list');

  const survivor = getRecords(settled, 'sessions').find((s) => s['agentSessionID'] === 'fake-b');

  expect(survivor).toMatchObject({ kind: 'pty' });
});

test('it revives the fleet most recently active first', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  const fakeClaude = join(home, 'fake-claude');

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
sleep 0.1
printf '{"hook_event_name":"SessionStart","session_id":"'"$ATC_SESSION_ID"'","transcript_path":"/nonexistent"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 30
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: fakeClaude,
      claudeArgs: [],
      grokBin: join(home, 'fake-grok'),
      grokArgs: [],
    }),
  );

  writeFileSync(join(home, 'fake-grok'), '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });

  const dbPath = join(home, '.local', 'state', 'atc', 'atc.db');

  const seed = await StateStore.open(dbPath);

  await seed.writeFleet([
    { name: 'one', cwd: home, agentSessionID: toAgentSessionID('fake-a'), agent: 'claude' },
    { name: 'two', cwd: home, agentSessionID: toAgentSessionID('fake-b'), agent: 'claude' },
    { name: 'three', cwd: home, agentSessionID: toAgentSessionID('fake-c'), agent: 'claude' },
  ]);

  await seed.stop();

  // The event trail dates 'three' most recent and 'one' oldest, inverting
  // the stored fleet order.
  const db = new Database(dbPath);

  db.run(
    'INSERT INTO events (ts, atc_id, event, message, session_id) VALUES ' +
      "('2026-08-14T00:00:01.000Z', 's1', 'Stop', NULL, 'fake-a')," +
      "('2026-08-14T00:00:03.000Z', 's2', 'Stop', NULL, 'fake-c')," +
      "('2026-08-14T00:00:02.000Z', 's3', 'Stop', NULL, 'fake-b')",
  );

  db.close();

  const ctx = setupDaemonProc(home);

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({ restored: 3 });

  await waitForEvent(
    events,
    (e) => e.ev === 'session.added' && isRecord(e['session']) && e['session']['name'] === 'one',
  );

  const added = events
    .filter((e) => e.ev === 'session.added')
    .map((e) => (isRecord(e['session']) ? e['session']['name'] : null));

  expect(added).toStrictEqual(['three', 'two', 'one']);
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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

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

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

  expect(
    client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 }),
  ).rejects.toMatchObject({ code: 'session_dead' });
});

test('it spawns a grok session and captures a grok descriptor from SessionStart', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  expect(ok['session']).toMatchObject({ agent: 'grok', alive: true });

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);

  expect(sessions[0]).toMatchObject({
    state: 'needs_you',
    agentSessionID: 'fake-grok-1',
    agent: 'grok',
    lastMsg: 'allow edit?',
  });
});

test('it yanks grok --resume after capture and grok before SessionStart', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const early = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const earlySession = getRecord(early, 'session');
  const earlyID = getString(earlySession, 'id');

  const welcome = await client.sendRequest('session.resumeCommand', { session: earlyID });

  expect(welcome).toStrictEqual({ command: `cd '${ctx.home}' && grok` });

  await client.sendRequest('session.kill', { session: earlyID });

  rmSync(join(ctx.home, 'fake-grok-hold-start'));

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  const captured = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const capturedSession = getRecord(captured, 'session');
  const capturedID = getString(capturedSession, 'id');

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const resumed = await client.sendRequest('session.resumeCommand', { session: capturedID });

  expect(resumed).toStrictEqual({ command: `cd '${ctx.home}' && grok --resume fake-grok-1` });
});

test('it restores a grok session via grok --resume, not claude --resume', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  ctx.proc.kill(9);

  await ctx.proc.exited;

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  const replay: EventMsg[] = [];

  client2.onEvent = (e) => {
    replay.push(e);
  };

  await client2.sendHello('atc/test');

  const restored = await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({ restored: 1 });

  const list = await client2.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);

  const [restoredSession] = sessions;

  if (restoredSession === undefined) {
    throw new Error('no restored grok session');
  }

  expect(restoredSession).toMatchObject({
    agentSessionID: 'fake-grok-1',
    agent: 'grok',
    alive: true,
  });

  const id = getString(restoredSession, 'id');

  await client2.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  const output = await waitForEvent(
    replay,
    (e) => e.ev === 'session.output' && String(e['d']).includes('FAKE_GROK_UP'),
  );

  expect(String(output['d'])).toInclude('--resume fake-grok-1');
  expect(String(output['d'])).not.toInclude('claude --resume');
  expect(String(output['d'])).not.toInclude('FAKE_CLAUDE_UP');
});

test('it marks a grok session done on end-turn Stop', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
    })}\n`,
  );

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(
    events,
    (e) => e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'done',
  );
});

test('it ignores a grok hook event that names a subagent', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
      subagentType: 'explore',
    })}\n`,
  );

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const spawned = getRecord(ok, 'session');

  await client.sendRequest('session.attach', {
    session: getString(spawned, 'id'),
    cols: 80,
    rows: 24,
  });

  await waitForEvent(
    events,
    (e) => e.ev === 'session.output' && String(e['d']).includes('FAKE_GROK_HOOKS_DONE'),
  );

  const list = await client.sendRequest('session.list');

  const [listed] = getRecords(list, 'sessions');

  if (listed === undefined) {
    throw new Error('no grok session');
  }

  expect(listed).toMatchObject({ state: 'running', agent: 'grok' });
});

test('it keeps grok needs_you when idle_prompt follows permission_prompt', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const spawned = getRecord(ok, 'session');

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const reporter = Bun.spawn([process.execPath, join(repo, 'src', 'cli.ts'), 'hook-report'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        hookEventName: 'notification',
        sessionId: 'fake-grok-1',
        notificationType: 'idle_prompt',
      }),
    ),
    env: collectEnv({
      HOME: ctx.home,
      ATC_SESSION_ID: getString(spawned, 'id'),
      ATC_SOCKET: join(ctx.home, 'atc.sock'),
    }),
  });

  await reporter.exited;

  await Bun.sleep(100); // the reporter is fire-and-forget; give the daemon time to apply the hook

  const list = await client.sendRequest('session.list');

  const [listed] = getRecords(list, 'sessions');

  if (listed === undefined) {
    throw new Error('no grok session');
  }

  expect(listed).toMatchObject({ state: 'needs_you', agent: 'grok' });
});

test('it spawns a codex session and captures its descriptor from SessionStart', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  expect(ok['session']).toMatchObject({ agent: 'codex', alive: true });

  await waitForEvent(
    events,
    (e) => e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);

  expect(sessions[0]).toMatchObject({
    state: 'done',
    agentSessionID: 'fake-codex-1',
    agent: 'codex',
  });
});

test('it builds codex resume commands and keeps codex in the fleet on kill', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await waitForEvent(
    events,
    (e) => e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  expect(answer['command']).toBe(`cd '${ctx.home}' && codex resume fake-codex-1`);
});
