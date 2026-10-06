import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { $ } from 'bun';
import type { Subprocess } from 'bun';
import { DaemonClient } from '../src/client/daemon-client';
import type { EventMsg } from '../src/protocol/protocol';
import { findDaemonRecord } from '../src/shared/find-daemon-record';
import { getRecord } from '../src/shared/get-record';
import { isRecord } from '../src/shared/report';
import { toAgentSessionID } from '../src/shared/to-agent-session-id';
import { toSessionID } from '../src/shared/to-session-id';
import { StateStore } from '../src/store/state-store';
import { updateEnv } from './update-env';
import { waitFor } from './wait-for';

const repo = dirname(import.meta.dir);

// The command every daemon and reporter in this suite runs as: the source
// entry under the test's own bun, or the compiled binary a smoke run points
// ATC_BIN at, so one suite proves both.
const atcCommand =
  process.env['ATC_BIN'] === undefined
    ? [process.execPath, join(repo, 'src', 'cli.ts')]
    : [process.env['ATC_BIN']];

const atcLine = atcCommand.map((part) => `"${part}"`).join(' ');
const hookReportCommand = `${atcLine} hook-report`;

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
  daemonArgs: readonly string[] = [],
): DaemonContext {
  const freshHome = home ?? mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  if (home === undefined) {
    mkdirSync(join(freshHome, '.config', 'atc'), { recursive: true });
    mkdirSync(join(freshHome, '.local', 'state', 'atc'), { recursive: true });

    const fakeClaude = join(freshHome, 'fake-claude');
    const fakeGrok = join(freshHome, 'fake-grok');
    const fakeCodex = join(freshHome, 'fake-codex');
    const hookReport = hookReportCommand;

    // The fake Claude reports through the hook command in the settings file
    // atc passed it, run through a shell as Claude runs it, so a session
    // reports with the command line atc wrote for its agent.
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
echo "FAKE_CLAUDE_TERM:[\${TERM-unset}]"
settings=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--settings" ]; then settings="$arg"; fi
  prev="$arg"
done
if [ -f "$HOME/fake-claude-hold-start" ]; then while read -r line; do echo "GOT:$line"; done; sleep 30; exit 0; fi
if [ -f "$HOME/fake-claude-composer" ]; then exec "${process.execPath}" "$HOME/fake-composer.js"; fi
hookCommand="$("${process.execPath}" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv.at(-1), "utf8")); console.log(s.hooks.SessionStart[0].hooks[0].command)' "$settings" < /dev/null)"
hookReport() { sh -c "$hookCommand"; }
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | hookReport
if [ -f "$HOME/fake-claude-tap" ]; then ${atcLine} tap --session "$ATC_SESSION_ID" >> "$HOME/tap.jsonl" & fi
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | hookReport
if [ -f "$HOME/fake-claude-events.jsonl" ]; then
  sleep 0.3
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | hookReport
    sleep 0.2
  done < "$HOME/fake-claude-events.jsonl"
fi
if [ -f "$HOME/fake-claude-exit" ]; then exit 0; fi
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
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | ${hookReport} --agent grok
if [ -f "$HOME/fake-grok-events.jsonl" ]; then
  sleep 0.3
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | ${hookReport} --agent grok
    sleep 0.2
  done < "$HOME/fake-grok-events.jsonl"
else
  sleep 0.3
  printf '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}' | ${hookReport} --agent grok
fi
echo "FAKE_GROK_HOOKS_DONE"
exec "${process.execPath}" "$HOME/fake-composer.js"
`,
      { mode: 0o755 },
    );

    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
echo "FAKE_CODEX_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"'"$HOME"'/fake-rollout.jsonl","cwd":"%s","source":"startup"}' "$PWD" | ${hookReport} --agent codex
sleep 0.3
printf '{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"'"$HOME"'/fake-rollout.jsonl","last_assistant_message":"pong"}' | ${hookReport} --agent codex
exec "${process.execPath}" "$HOME/fake-composer.js"
`,
      { mode: 0o755 },
    );

    // The composer the fake Codex and Grok finish in, and the fake Claude
    // when fake-claude-composer exists, modelled on the TUIs those agents
    // draw: raw mode with bracketed paste on.
    // Each read is one input event batch. A bracketed paste lands in the
    // composer whole, newlines kept; a lone CR outside a paste submits; a
    // lone LF is Ctrl-J and adds a newline; any other read of more than one
    // byte is a paste burst whose line breaks stay in the composer. A read
    // that ends partway into a paste marker holds that part for the next
    // read. After each read it prints every byte received so far as
    // RECEIVED:<json>, and it prints each submission as SUBMIT:<json>.
    writeFileSync(
      join(freshHome, 'fake-composer.js'),
      String.raw`const OPEN = '\u001B[200~';
const CLOSE = '\u001B[201~';
let composer = '';
let pasting = false;
let held = '';
let received = '';
process.stdin.setRawMode(true);
process.stdout.write('\u001B[?2004hFAKE_COMPOSER_READY\r\n');
process.stdin.on('data', (buf) => {
  const chunk = buf.toString('utf8');
  received += chunk;
  process.stdout.write('RECEIVED:' + JSON.stringify(received) + '\r\n');
  let rest = held + chunk;
  held = '';
  const cut = rest.lastIndexOf('\u001B');
  const tail = cut === -1 ? '' : rest.slice(cut);
  if (tail !== '' && tail.length < CLOSE.length && (OPEN.startsWith(tail) || CLOSE.startsWith(tail))) {
    held = tail;
    rest = rest.slice(0, cut);
  }
  while (rest !== '') {
    if (pasting) {
      const end = rest.indexOf(CLOSE);
      composer += (end === -1 ? rest : rest.slice(0, end)).replaceAll('\r', '\n');
      pasting = end === -1;
      rest = end === -1 ? '' : rest.slice(end + CLOSE.length);
      continue;
    }
    if (rest.startsWith(OPEN)) {
      pasting = true;
      rest = rest.slice(OPEN.length);
      continue;
    }
    const next = rest.indexOf(OPEN);
    const plain = next === -1 ? rest : rest.slice(0, next);
    rest = next === -1 ? '' : rest.slice(next);
    if (plain === '\r') {
      process.stdout.write('SUBMIT:' + JSON.stringify(composer) + '\r\n');
      composer = '';
    } else {
      composer += plain.replaceAll('\r', '\n');
    }
  }
});
`,
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
        gateways: { zai: { baseURL: 'http://127.0.0.1:9' } },

        // These tests drive the restore through fleet.restore themselves.
        restoreFleetOnRestart: false,

        // The workspace tests clone fixture repositories from local paths.
        workspaces: { gitTransports: ['https', 'ssh', 'file'] },
      }),
    );
  }

  // The daemon's stderr is kept so a boot that never listens explains
  // itself in the failure instead of leaving only a timeout.
  const stderrPath = join(freshHome, 'daemon.stderr');

  const proc = Bun.spawn([...atcCommand, 'daemon', ...daemonArgs], {
    env: collectEnv({
      HOME: freshHome,
      XDG_RUNTIME_DIR: freshHome,
      PATH: '/usr/sbin:/usr/bin:/bin',
      ...extraEnv,
    }),
    stdout: 'ignore',
    stderr: Bun.file(stderrPath),
  });

  const daemonSock = join(freshHome, 'atc-daemon.sock');
  const clients: DaemonClient[] = [];

  // Generous because a compiled binary's first launch on a shared macOS
  // runner spends seconds in the code-signing scan before the daemon
  // listens.
  const openClient = async () => {
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      try {
        const client = await DaemonClient.open(daemonSock);

        clients.push(client);

        return client;
      } catch {
        await Bun.sleep(50);
      }
    }

    let stderr = '';

    try {
      stderr = readFileSync(stderrPath, 'utf8').slice(-2000);
    } catch {}

    throw new Error(`daemon socket never came up (exit ${proc.exitCode}):\n${stderr}`);
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

test('it spawns a session and broadcasts SessionAdded to every client', async () => {
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

  const added = await waitForEvent(events, (e) => e.ev === 'SessionAdded');

  expect(added['session']).toMatchObject({ cwd: ctx.home, state: 'running' });
});

test('it turns hook notifications into SessionState broadcasts', async () => {
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const reporter = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'claude'], {
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
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['lastMsg'] === 'session ended',
  );

  expect(ended).toMatchObject({ session: { alive: true, kind: 'pty', state: 'needs_you' } });

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions[0]).toMatchObject({ alive: true, state: 'needs_you', lastMsg: 'session ended' });
});

test('it stops showing a live terminal as ended once a new session starts in it', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    [
      { hook_event_name: 'Stop', session_id: 'fake-1', last_assistant_message: 'All done.' },
      { hook_event_name: 'SessionEnd', session_id: 'fake-1', reason: 'clear' },
      {
        hook_event_name: 'SessionStart',
        session_id: 'fake-2',
        source: 'clear',
        transcript_path: join(ctx.home, 'fake-transcript-2.jsonl'),
      },
    ]
      .map((ev) => `${JSON.stringify(ev)}\n`)
      .join(''),
  );

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  // The fake Claude sends its hooks one reporter launch at a time, and a
  // loaded runner can spend seconds on each launch, so each wait covers one
  // hook rather than the whole chain.
  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['agentSessionID'] === 'fake-1',
  );

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['lastMsg'] === 'session ended',
  );

  const restarted = await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['agentSessionID'] === 'fake-2',
  );

  expect(restarted).toMatchObject({
    session: { alive: true, kind: 'pty', state: 'done', lastMsg: 'started' },
  });

  const record = await client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    session: { alive: true, state: 'done', lastMsg: 'started', agentSessionID: 'fake-2' },
  });
});

test('it keeps a gone terminal exited when a late end and start arrive', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-exit'), '');

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['state'] === 'exited' &&
      e['session']['alive'] === false,
  );

  const env = collectEnv({
    HOME: ctx.home,
    ATC_SESSION_ID: id,
    ATC_SOCKET: join(ctx.home, 'atc.sock'),
  });

  const endReporter = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'claude'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fake-1', reason: 'clear' }),
    ),
    env,
  });

  await endReporter.exited;

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['lastMsg'] === 'session ended',
  );

  const startReporter = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'claude'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-2', source: 'clear' }),
    ),
    env,
  });

  await startReporter.exited;

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['agentSessionID'] === 'fake-2',
  );

  const record = await client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    session: { alive: false, state: 'exited', lastMsg: 'session ended', agentSessionID: 'fake-2' },
  });
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
    (e) => e.ev === 'SessionRenamed' && e['name'] === 'auth-bug',
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, (e) => e.ev === 'SessionRemoved' && e['s'] === id);

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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
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

test('it lets exactly one of two daemons started at once serve a state directory', async () => {
  const first = setupDaemonProc();
  const second = setupDaemonProc(first.home);

  const loserCode = await Promise.race([first.proc.exited, second.proc.exited]);
  const client = await first.openClient();

  await client.sendHello('atc/test');

  const live = [first.proc, second.proc].filter((proc) => proc.exitCode === null);
  const [survivor] = live;

  if (survivor === undefined) {
    throw new Error('neither daemon is serving');
  }

  const record: unknown = JSON.parse(
    readFileSync(join(first.home, '.local', 'state', 'atc', 'daemon.json'), 'utf8'),
  );

  expect(loserCode).toBe(1);
  expect(live).toHaveLength(1);
  expect(record).toMatchObject({ pid: survivor.pid, socketPath: first.daemonSock });

  expect(readFileSync(join(first.home, 'daemon.stderr'), 'utf8')).toInclude(
    'another daemon already serves',
  );
});

test('it starts a daemon on the state directory of one killed with SIGKILL', async () => {
  const crashed = setupDaemonProc();

  await crashed.openClient();

  crashed.proc.kill(9);

  await crashed.proc.exited;

  const next = setupDaemonProc(crashed.home);

  const client = await next.openClient();

  await client.sendHello('atc/test');

  const record: unknown = JSON.parse(
    readFileSync(join(crashed.home, '.local', 'state', 'atc', 'daemon.json'), 'utf8'),
  );

  expect(next.proc.exitCode).toBeNull();
  expect(record).toMatchObject({ pid: next.proc.pid });
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
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
printf '{"hook_event_name":"SessionStart","session_id":"'"$ATC_SESSION_ID"'","transcript_path":"/nonexistent"}' | ${hookReportCommand}
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
      restoreFleetOnRestart: false,
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
      e.ev === 'SessionState' &&
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
printf '{"hook_event_name":"SessionStart","session_id":"'"$ATC_SESSION_ID"'","transcript_path":"/nonexistent"}' | ${hookReportCommand}
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
      restoreFleetOnRestart: false,
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
      e.ev === 'SessionState' &&
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
printf '{"hook_event_name":"SessionStart","session_id":"'"$ATC_SESSION_ID"'","transcript_path":"/nonexistent"}' | ${hookReportCommand}
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
      restoreFleetOnRestart: false,
    }),
  );

  writeFileSync(join(home, 'fake-grok'), '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });

  const dbPath = join(home, '.local', 'state', 'atc', 'atc.db');

  const seed = await StateStore.open(dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-fake-a'),
      name: 'one',
      cwd: home,
      agentSessionID: toAgentSessionID('fake-a'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-fake-b'),
      name: 'two',
      cwd: home,
      agentSessionID: toAgentSessionID('fake-b'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-fake-c'),
      name: 'three',
      cwd: home,
      agentSessionID: toAgentSessionID('fake-c'),
      agent: 'claude',
    },
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
    (e) => e.ev === 'SessionAdded' && isRecord(e['session']) && e['session']['name'] === 'one',
  );

  const added = events
    .filter((e) => e.ev === 'SessionAdded')
    .map((e) => (isRecord(e['session']) ? e['session']['name'] : null));

  expect(added).toStrictEqual(['three', 'two', 'one']);
});

test('it broadcasts PermissionRequested when a session needs input', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const requested = await waitForEvent(events, (e) => e.ev === 'PermissionRequested');

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

  const requested = await waitForEvent(events, (e) => e.ev === 'PermissionRequested');

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

  const requested = await waitForEvent(events, (e) => e.ev === 'PermissionRequested');

  const request = getString(requested, 'request');

  await client.sendRequest('session.kill', { session: id });

  const resolved = await waitForEvent(
    events,
    (e) => e.ev === 'PermissionResolved' && e['request'] === request,
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
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('GOT:hello'),
  );

  const seqs = events.filter((e) => e.ev === 'SessionOutput').map((e) => Number(e['seq']));

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
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('GOT:ping'),
  );

  const leaked = leaverEvents.filter(
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('GOT:ping'),
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

  await waitForEvent(events, (e) => e.ev === 'SessionResized' && e['cols'] === 120);

  await narrow.sendRequest('session.attach', { session: id, cols: 90, rows: 28 });

  const shrunk = await waitForEvent(events, (e) => e.ev === 'SessionResized' && e['cols'] === 90);

  expect(shrunk).toMatchObject({ s: id, cols: 90, rows: 28 });
});

test('it resizes the pty before the attach replay reaches the client', async () => {
  const ctx = setupDaemonProc();

  const spawner = await ctx.openClient();

  await spawner.sendHello('atc/test');

  const ok = await spawner.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  const joiner = await ctx.openClient();

  const events: EventMsg[] = [];

  joiner.onEvent = (e) => {
    events.push(e);
  };

  await joiner.sendHello('atc/test');
  await joiner.sendRequest('session.attach', { session: id, cols: 100, rows: 30 });

  await waitForEvent(events, (e) => e.ev === 'SessionOutput' && e['s'] === id);

  const resizedAt = events.findIndex((e) => e.ev === 'SessionResized' && e['cols'] === 100);
  const outputAt = events.findIndex((e) => e.ev === 'SessionOutput' && e['s'] === id);

  expect(resizedAt).toBeGreaterThanOrEqual(0);
  expect(outputAt).toBeGreaterThan(resizedAt);
});

test('it reads the current screen of a session as plain text without attaching', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  // Input typed before the fake agent prints its banner echoes above it,
  // so the banner is awaited first.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_UP');
  });

  await client.sendRequest('session.input', { session: id, d: 'hello\n' });

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('GOT:hello');

    return read;
  });

  expect(screen).toStrictEqual({
    text: expect.toStartWith('FAKE_CLAUDE_UP args:'),
    cols: 80,
    rows: 24,
  });

  expect(screen['text']).not.toInclude('\u001B');
});

test('it starts a session with TERM xterm-256color when the daemon starts with no TERM', async () => {
  updateEnv('TERM', undefined);

  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:[xterm-256color]');
  });
});

test.each([
  { daemonTERM: 'dumb', sessionTERM: 'xterm-256color' },
  { daemonTERM: 'screen-256color', sessionTERM: 'screen-256color' },
])(
  'it starts a session with TERM $sessionTERM when the daemon starts with TERM $daemonTERM',
  async (row) => {
    const ctx = setupDaemonProc(undefined, { TERM: row.daemonTERM });

    const client = await ctx.openClient();

    await client.sendHello('atc/test');

    const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

    const spawned = getRecord(ok, 'session');
    const id = getString(spawned, 'id');

    await waitFor(async () => {
      const read = await client.sendRequest('session.screen', { session: id });

      expect(read['text']).toInclude(`FAKE_CLAUDE_TERM:[${row.sessionTERM}]`);
    });
  },
);

test('it keeps the last screen of a killed session readable', async () => {
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

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_UP');
  });

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

  const screen = await client.sendRequest('session.screen', { session: id });

  expect(screen['text']).toInclude('FAKE_CLAUDE_UP');
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

  expect(client.sendRequest('session.input', { session: id, d: 'x' })).rejects.toMatchObject({
    code: 'session_dead',
  });
});

test('it answers session.submit on a dead session with session_dead', async () => {
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
  );

  expect(client.sendRequest('session.submit', { session: id, text: 'x' })).rejects.toMatchObject({
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['lastMsg'] === 'killed',
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
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
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('FAKE_GROK_UP'),
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
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
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
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('FAKE_GROK_HOOKS_DONE'),
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
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const reporter = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'grok'], {
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
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
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
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  expect(answer['command']).toBe(`cd '${ctx.home}' && codex resume fake-codex-1`);
});

test('it submits a line to a codex session as one submission', async () => {
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

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // The client sees output before the daemon's screen model has parsed it,
  // and a submit reads the paste mode from that model. A screen read waits
  // for the parse, so once it shows the banner, the paste mode the composer
  // turned on just before it is in force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', { session: id, text: 'hello' });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('SUBMIT:"hello"'),
  );
});

test('it submits a multi-line text to a codex session as one submission', async () => {
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

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // The client sees output before the daemon's screen model has parsed it,
  // and a submit reads the paste mode from that model. A screen read waits
  // for the parse, so once it shows the banner, the paste mode the composer
  // turned on just before it is in force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', { session: id, text: 'first\nsecond' });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes(String.raw`SUBMIT:"first\nsecond"`),
  );
});

test('it submits a line to a grok session as one submission', async () => {
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

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // The client sees output before the daemon's screen model has parsed it,
  // and a submit reads the paste mode from that model. A screen read waits
  // for the parse, so once it shows the banner, the paste mode the composer
  // turned on just before it is in force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', { session: id, text: 'hello' });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('SUBMIT:"hello"'),
  );
});

test('it submits a line to a claude session as one line', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('FAKE_CLAUDE_UP'),
  );

  await client.sendRequest('session.submit', { session: id, text: 'hello' });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('GOT:hello'),
  );
});

test('it submits a long line to a claude session as one submission', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-composer'), '');

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // A screen read waits for the daemon's parse, so once it shows the banner,
  // the paste mode the composer turned on just before it is in force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', { session: id, text: 'a'.repeat(1600) });

  // A PTY can deliver the long SUBMIT line across several output events, so
  // the check reads the output joined.
  await waitFor(() => {
    expect(
      events
        .filter((e) => e.ev === 'SessionOutput')
        .map((e) => String(e['d']))
        .join(''),
    ).toInclude(`SUBMIT:"${'a'.repeat(1600)}"`);
  });
});

test('it submits a claude composer draft on an empty line without adding a line to it', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-composer'), '');

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.input', { session: id, d: 'draft' });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('RECEIVED:"draft"'),
  );

  await client.sendRequest('session.submit', { session: id, text: '' });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('SUBMIT:"draft"'),
  );
});

test('it writes raw input to a codex session byte for byte', async () => {
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

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionOutput' && String(e['d']).includes('FAKE_COMPOSER_READY'),
  );

  await client.sendRequest('session.input', { session: id, d: 'abc\u001B[Ax\n' });

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionOutput' && String(e['d']).includes(String.raw`RECEIVED:"abc\u001b[Ax\n"`),
  );
});

test("it reports a session's pending prompt through session.get while it needs you", async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const start = Date.now();

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'pending-check',
    prompt: 'fix the auth bug',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const record = await client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    prompt: 'fix the auth bug',
    pending: { message: 'needs permission' },
    result: null,
    session: { state: 'needs_you' },
  });

  expect(record['lastActivityAt']).toBeWithin(start, Date.now() + 1);
});

test("it reports a finished turn's last message through session.get", async () => {
  const ctx = setupDaemonProc();

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'fake-1',
      last_assistant_message: 'All tests pass.',
    })}\n`,
  );

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(
    events,
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

  const record = await client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({ result: 'All tests pass.', pending: null });
});

test('it keeps the spawn prompt and latest result across a daemon restart', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'fake-1',
      last_assistant_message: 'All tests pass.',
    })}\n`,
  );

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    prompt: 'fix the auth bug',
    cols: 80,
    rows: 24,
  });

  // The turn's end reaching the daemon is waited for on its own, so a slow
  // hook delivery and a lost fleet write fail at different lines.
  await waitForEvent(
    events,
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

  await waitFor(async () => {
    const listed = await client.sendRequest('fleet.list');

    const fleet = getRecords(listed, 'fleet');

    expect(fleet[0]).toMatchObject({
      prompt: 'fix the auth bug',
      result: 'All tests pass.',
      transcriptPath: join(ctx.home, 'fake-transcript.jsonl'),
    });
  });

  ctx.proc.kill(9);

  await ctx.proc.exited;

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  await client2.sendHello('atc/test');
  await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await client2.sendRequest('session.list');

  const sessions = getRecords(listed, 'sessions');
  const id = getString(sessions[0] ?? {}, 'id');

  const record = await client2.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({ prompt: 'fix the auth bug', result: 'All tests pass.' });
});

test("it pages a claude session's transcript through session.read", async () => {
  const ctx = setupDaemonProc();
  const t0 = '2026-10-01T10:00:00.000Z';
  const t1 = '2026-10-01T10:00:05.000Z';
  const t2 = '2026-10-01T10:00:06.000Z';
  const t3 = '2026-10-01T10:00:09.000Z';
  const t4 = '2026-10-01T10:01:00.000Z';

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    [
      { type: 'user', message: { role: 'user', content: 'fix the auth bug' }, timestamp: t0 },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running the tests.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
        timestamp: t1,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
        timestamp: t2,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'All green.' }] },
        timestamp: t3,
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const first = await waitFor(async () => {
    const page = await client.sendRequest('session.read', { session: id, limit: 2 });

    expect(getRecords(page, 'rows')).toHaveLength(2);

    return page;
  });

  expect(first).toStrictEqual({
    rows: [
      { role: 'user', text: 'fix the auth bug', tools: [], at: Date.parse(t0) },
      {
        role: 'assistant',
        text: 'Running the tests.',
        tools: [{ name: 'Bash', input: 'bun test' }],
        at: Date.parse(t1),
      },
    ],
    cursor: expect.any(String),
    more: true,
  });

  const second = await client.sendRequest('session.read', {
    session: id,
    cursor: first['cursor'],
    limit: 2,
  });

  expect(second).toStrictEqual({
    rows: [{ role: 'assistant', text: 'All green.', tools: [], at: Date.parse(t3) }],
    cursor: expect.any(String),
    more: false,
  });

  appendFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'thanks' }, timestamp: t4 })}\n`,
  );

  const third = await client.sendRequest('session.read', {
    session: id,
    cursor: second['cursor'],
    limit: 2,
  });

  expect(third).toStrictEqual({
    rows: [{ role: 'user', text: 'thanks', tools: [], at: Date.parse(t4) }],
    cursor: expect.any(String),
    more: false,
  });
});

test.each([['grok'], ['codex']])(
  'it answers session.read on a %s session with unsupported',
  async (agent) => {
    const ctx = setupDaemonProc();

    const client = await ctx.openClient();

    await client.sendHello('atc/test');

    const ok = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      agent,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(ok, 'session'), 'id');

    expect(client.sendRequest('session.read', { session: id })).rejects.toMatchObject({
      code: 'unsupported',
    });
  },
);

test('it reads hook events from a cursor through events.read', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'watched',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const answer = await waitFor(async () => {
    const read = await client.sendRequest('events.read', {});

    expect(getRecords(read, 'events')).toHaveLength(2);

    return read;
  });

  expect(answer).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'watched',
        kind: 'started',
        detail: null,
      },
      {
        cursor: expect.toBeString(),
        at: expect.toBeNumber(),
        session: id,
        name: 'watched',
        kind: 'needs-input',
        detail: 'needs permission',
      },
    ],
    cursor: expect.toBeString(),
    more: false,
  });

  const cursor = getString(answer, 'cursor');

  const next = await client.sendRequest('events.read', { cursor });

  expect(next).toStrictEqual({ events: [], cursor, more: false });
});

test('it holds events.read open until the next event arrives', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const first = await client.sendRequest('events.read', {});

  const pending = client.sendRequest('events.read', { cursor: first['cursor'], waitMs: 10_000 });
  const start = Date.now();

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'late',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const answered = await pending;

  expect(getRecords(answered, 'events')[0]).toMatchObject({ kind: 'started', session: id });
  expect(Date.now()).toBeWithin(start, start + 9000);
});

test('it carries a message from accepted through delivered to answered', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(spawned, 'session'), 'id');

  // The session may have started without its tap connected yet, so the
  // message queues for the tap to drain.
  const sent = await client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  await waitFor(() => {
    expect(readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8')).toInclude(messageID);
  });

  const tapped = readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8');

  expect(tapped).toInclude('ping from test');

  const delivered = await waitForEvent(
    events,
    (e) => e.ev === 'SessionMessage' && e['status'] === 'delivered',
  );

  expect(delivered).toMatchObject({ s: id, message: messageID, from: 'e2e' });

  const reporter = Bun.spawn([...atcCommand, 'report', 'answered', '--message', messageID], {
    stdin: new TextEncoder().encode('final text'),
    env: collectEnv({ ATC_SOCKET: join(ctx.home, 'atc.sock'), ATC_SESSION_ID: id }),
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const reporterCode = await reporter.exited;

  expect(reporterCode).toBe(0);

  const answered = await waitForEvent(
    events,
    (e) => e.ev === 'SessionMessage' && e['status'] === 'answered',
  );

  expect(answered).toMatchObject({ s: id, message: messageID, answerPreview: 'final text' });

  const screen = await client.sendRequest('session.screen', { session: id });

  expect(getString(screen, 'text')).not.toInclude('ping from test');
});

test('it delivers a message accepted before a daemon crash to the restored session', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: originalID,
    text: 'survive the crash',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  ctx.proc.kill(9);

  await ctx.proc.exited;

  rmSync(join(ctx.home, 'fake-claude-hold-start'));
  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  const events: EventMsg[] = [];

  client2.onEvent = (e) => {
    events.push(e);
  };

  await client2.sendHello('atc/test');

  const restored = await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({ restored: 1 });

  await waitFor(() => {
    expect(readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8')).toInclude(messageID);
  });

  const tapped = readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8');

  expect(tapped).toInclude('survive the crash');

  const list = await client2.sendRequest('session.list');

  const restoredID = getString(getRecords(list, 'sessions')[0] ?? {}, 'id');

  expect(restoredID).toBe(originalID);

  const delivered = await waitForEvent(
    events,
    (e) => e.ev === 'SessionMessage' && e['status'] === 'delivered',
  );

  expect(delivered).toMatchObject({ s: restoredID, message: messageID });
});

test('it names a message event from before a daemon crash by the restored session', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: originalID,
    text: 'survive the crash',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  ctx.proc.kill(9);

  await ctx.proc.exited;

  rmSync(join(ctx.home, 'fake-claude-hold-start'));
  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  const events: EventMsg[] = [];

  client2.onEvent = (e) => {
    events.push(e);
  };

  await client2.sendHello('atc/test');
  await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const list = await client2.sendRequest('session.list');

  const restoredID = getString(getRecords(list, 'sessions')[0] ?? {}, 'id');

  await waitForEvent(events, (e) => e.ev === 'SessionMessage' && e['status'] === 'delivered');

  const read = await waitFor(async () => {
    const answer = await client2.sendRequest('events.read', {});

    const ours = getRecords(answer, 'events').filter((e) => e['message'] === messageID);

    expect(ours).toHaveLength(2);

    return ours;
  });

  expect(read).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: restoredID,
      name: expect.toBeString(),
      kind: 'message-accepted',
      detail: 'survive the crash',
      message: messageID,
    },
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: restoredID,
      name: expect.toBeString(),
      kind: 'message-delivered',
      detail: 'survive the crash',
      message: messageID,
    },
  ]);
});

test('it names a message event sent before SessionStart by the restored session', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: originalID,
    text: 'sent before start',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  const reporter = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'claude'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-1' }),
    ),
    env: { ...process.env, ATC_SOCKET: join(ctx.home, 'atc.sock'), ATC_SESSION_ID: originalID },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await reporter.exited;

  await waitFor(async () => {
    const list = await client.sendRequest('session.list');

    expect(getRecords(list, 'sessions')[0]).toMatchObject({ agentSessionID: 'fake-1' });
  });

  ctx.proc.kill(9);

  await ctx.proc.exited;

  rmSync(join(ctx.home, 'fake-claude-hold-start'));

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  await client2.sendHello('atc/test');
  await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const list = await client2.sendRequest('session.list');

  const restoredSession = getRecords(list, 'sessions')[0] ?? {};
  const restoredID = getString(restoredSession, 'id');
  const restoredName = getString(restoredSession, 'name');

  expect(restoredID).toBe(originalID);

  const read = await waitFor(async () => {
    const answer = await client2.sendRequest('events.read', {});

    const ours = getRecords(answer, 'events').filter((e) => e['message'] === messageID);

    expect(ours).toHaveLength(1);

    return ours;
  });

  expect(read).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: restoredID,
      name: restoredName,
      kind: 'message-accepted',
      detail: 'sent before start',
      message: messageID,
    },
  ]);
});

test('it starts a Claude session with the atc-bridge mod folder', async () => {
  const ctx = setupDaemonProc();
  const bridgeDir = join(ctx.home, '.local', 'state', 'atc', 'atc-bridge');

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  // Wide enough that the echoed args line never wraps mid-path.
  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 400, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude(`--plugin-dir ${bridgeDir}`);
  });

  expect(readFileSync(join(bridgeDir, '.claude-plugin', 'plugin.json'), 'utf8')).toInclude(
    '"name": "atc-bridge"',
  );

  expect(readFileSync(join(bridgeDir, 'hooks', 'atc-cli.ts'), 'utf8')).toIncludeMultiple(
    atcCommand,
  );
});

test('it starts a gateway session with the atc-bridge mod folder', async () => {
  const ctx = setupDaemonProc();
  const bridgeDir = join(ctx.home, '.local', 'state', 'atc', 'atc-bridge');

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 400,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude(`--plugin-dir ${bridgeDir}`);
  });
});

test("it revives a restored session with the spawn's model and effort", async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    model: 'opus[1m]',
    effort: 'xhigh',
    cols: 400,
    rows: 24,
  });

  await waitFor(async () => {
    const listed = await client.sendRequest('fleet.list');

    expect(getRecords(listed, 'fleet')[0]).toMatchObject({
      agentSessionID: 'fake-1',
      model: 'opus[1m]',
      effort: 'xhigh',
    });
  });

  ctx.proc.kill(9);

  await ctx.proc.exited;

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  await client2.sendHello('atc/test');
  await client2.sendRequest('fleet.restore', { cols: 400, rows: 24 });

  const listed = await client2.sendRequest('session.list');

  const id = getString(getRecords(listed, 'sessions')[0] ?? {}, 'id');

  await waitFor(async () => {
    const read = await client2.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('args: --model opus[1m] --effort xhigh --settings');
    expect(read['text']).toInclude('--resume fake-1');
  });
});

test('it revives a restored session that has no model or effort without either flag', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 400, rows: 24 });

  await waitFor(async () => {
    const listed = await client.sendRequest('fleet.list');

    expect(getRecords(listed, 'fleet')[0]).toMatchObject({ agentSessionID: 'fake-1' });
  });

  ctx.proc.kill(9);

  await ctx.proc.exited;

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  await client2.sendHello('atc/test');

  const stored = await client2.sendRequest('fleet.list');

  const fleet = getRecords(stored, 'fleet');

  await client2.sendRequest('fleet.restore', { cols: 400, rows: 24 });

  const listed = await client2.sendRequest('session.list');

  const id = getString(getRecords(listed, 'sessions')[0] ?? {}, 'id');

  await waitFor(async () => {
    const read = await client2.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('args: --settings');
    expect(read['text']).toInclude('--resume fake-1');
  });

  expect(fleet[0]).not.toContainAnyKeys(['model', 'effort']);
});

test('it starts with a broken config, prints the problem, and refuses every spawn, local included', async () => {
  const first = setupDaemonProc();

  first.proc.kill();

  await first.proc.exited;

  const configPath = join(first.home, '.config', 'atc', 'config.json');

  writeFileSync(configPath, '{ "targets": { "box": { "provider": "imp" } },');

  // The broken file drops the configured claude binary, so the default name
  // resolves on PATH to the fake one.
  mkdirSync(join(first.home, 'bin'));
  symlinkSync(join(first.home, 'fake-claude'), join(first.home, 'bin', 'claude'));

  const ctx = setupDaemonProc(first.home, {
    PATH: `${join(first.home, 'bin')}:/usr/sbin:/usr/bin:/bin`,
  });

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const spawn = client.sendRequest('session.spawn', { cwd: ctx.home, target: 'local' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'config_malformed', path: configPath },
  });

  expect(client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });

  expect(readFileSync(join(ctx.home, 'daemon.stderr'), 'utf8')).toInclude(
    `atc daemon: config: ${configPath} cannot be used (config_malformed: `,
  );
});

test('it prints one line naming the old agent keys a config still uses and loads them as before', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(getRecords(listed, 'agents').map((agent) => agent['id'])).toStrictEqual([
    'claude',
    'grok',
    'codex',
    'zai',
  ]);

  expect(readFileSync(join(ctx.home, 'daemon.stderr'), 'utf8')).toInclude(
    "atc daemon: config: config.json uses the old agent keys (claudeBin, claudeArgs, grokBin, grokArgs, codexBin, codexArgs, gateways); run 'atc config migrate' to move them into agents\n",
  );
});

test('it lists exactly the agents of an agents map and prints no old-key line', async () => {
  const first = setupDaemonProc();

  first.proc.kill();

  await first.proc.exited;

  writeFileSync(
    join(first.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        'claude-b': { kind: 'claude', bin: join(first.home, 'fake-claude') },
        codex: { bin: join(first.home, 'fake-codex') },
      },
    }),
  );

  const ctx = setupDaemonProc(first.home);

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(getRecords(listed, 'agents').map((agent) => agent['id'])).toStrictEqual([
    'claude-b',
    'codex',
  ]);

  expect(getRecord(listed, 'spawnDefaults')['agent']).toBe('claude-b');
  expect(readFileSync(join(ctx.home, 'daemon.stderr'), 'utf8')).not.toInclude('old agent keys');
});

test.each([
  [
    'JSON with a syntax error at the value',
    '{ "targets": { "local": { "provider": "local-pty" } }, "token": sk_fixture_NOT_A_SECRET_1234 }',
  ],
  [
    'a defaultTarget object holding the value',
    '{ "targets": { "local": { "provider": "local-pty" } }, "defaultTarget": { "token": "sk_fixture_NOT_A_SECRET_1234" } }',
  ],
  [
    'a malformed target entry holding the value',
    '{ "targets": { "local": { "provider": "local-pty" }, "box": { "provider": 7, "token": "sk_fixture_NOT_A_SECRET_1234" } } }',
  ],
])('it prints the config problem without the config value for %s', async (_label, text) => {
  const first = setupDaemonProc();

  first.proc.kill();

  await first.proc.exited;

  writeFileSync(join(first.home, '.config', 'atc', 'config.json'), text);

  const ctx = setupDaemonProc(first.home);

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const stderr = readFileSync(join(ctx.home, 'daemon.stderr'), 'utf8');

  expect(stderr).toInclude('atc daemon: config: ');
  expect(stderr).not.toInclude('sk_fixture_NOT_A_SECRET_1234');
});

test('it keeps the configured model and effort when a spawn sets neither', async () => {
  const first = setupDaemonProc();

  first.proc.kill();

  await first.proc.exited;

  const configPath = join(first.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      claudeArgs: ['--model', 'opus', '--effort', 'low'],
    }),
  );

  const ctx = setupDaemonProc(first.home);

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const claude = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 400, rows: 24 });

  const gateway = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 400,
    rows: 24,
  });

  await waitFor(async () => {
    const screens = await Promise.all(
      [claude, gateway].map((ok) =>
        client.sendRequest('session.screen', {
          session: getString(getRecord(ok, 'session'), 'id'),
        }),
      ),
    );

    expect(screens.map((read) => read['text'])).toSatisfyAll((text: unknown) =>
      String(text).includes('args: --model opus --effort low --settings'),
    );
  });
});

test("it replaces the configured model and effort with a spawn's overrides", async () => {
  const first = setupDaemonProc();

  first.proc.kill();

  await first.proc.exited;

  const configPath = join(first.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      claudeArgs: ['--model', 'opus', '--effort', 'low'],
    }),
  );

  const ctx = setupDaemonProc(first.home);

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const claude = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    model: 'sonnet',
    cols: 400,
    rows: 24,
  });

  const gateway = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    model: 'haiku',
    effort: 'max',
    cols: 400,
    rows: 24,
  });

  await waitFor(async () => {
    const screens = await Promise.all(
      [claude, gateway].map((ok) =>
        client.sendRequest('session.screen', {
          session: getString(getRecord(ok, 'session'), 'id'),
        }),
      ),
    );

    const [claudeScreen, gatewayScreen] = screens.map((read) => String(read['text']));

    if (claudeScreen === undefined || gatewayScreen === undefined) {
      throw new Error('a spawned session has no screen');
    }

    expect(claudeScreen).toInclude('args: --effort low --model sonnet --settings');
    expect(gatewayScreen).toInclude('args: --model haiku --effort max --settings');
  });
});

test("it runs and stores a resume request's own model and effort", async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    model: 'haiku',
    effort: 'medium',
    cols: 400,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('args: --model haiku --effort medium --settings');
  });

  await waitFor(async () => {
    const listed = await client.sendRequest('fleet.list');

    expect(getRecords(listed, 'fleet')[0]).toMatchObject({
      agentSessionID: 'fake-1',
      model: 'haiku',
      effort: 'medium',
    });
  });
});

// TAR_OPTIONS reaches tar only through the environment a process starts
// with, so the daemon here starts with it set.
test('it unpacks every tracked file of a local workspace when the daemon env asks tar to exclude some', async () => {
  const ctx = setupDaemonProc(undefined, { TAR_OPTIONS: '--exclude=*.txt' });

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  const upstream = join(ctx.home, 'upstream.git');
  const work = join(ctx.home, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  writeFileSync(join(work, 'notes.txt'), 'kept\n');

  await $`git add notes.txt`.env(env).cwd(work).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com commit --quiet -m notes`
    .env(env)
    .cwd(work)
    .quiet();

  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const dest = join(ctx.home, 'ws');

  await client.sendRequest('session.spawn', {
    cwd: dest,
    workspace: { kind: 'git', url: upstream, ref: 'main' },
  });

  expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('kept\n');
});

test('it keeps a nested codex harness from rebinding or answering for the claude session it runs in', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const sent = await client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  await waitForEvent(events, (e) => e.ev === 'SessionMessage' && e['status'] === 'delivered');

  const childStart = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'codex'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'nested-codex-1',
        transcript_path: `${ctx.home}/nested-rollout.jsonl`,
        source: 'startup',
      }),
    ),
    env: collectEnv({ HOME: ctx.home, ATC_SESSION_ID: id, ATC_SOCKET: join(ctx.home, 'atc.sock') }),
  });

  const childStartCode = await childStart.exited;

  const childStop = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'codex'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'nested-codex-1',
        last_assistant_message: 'nested codex output',
      }),
    ),
    env: collectEnv({ HOME: ctx.home, ATC_SESSION_ID: id, ATC_SOCKET: join(ctx.home, 'atc.sock') }),
  });

  const childStopCode = await childStop.exited;
  const record = await client.sendRequest('session.get', { session: id });
  const message = await client.sendRequest('message.get', { message: messageID });

  expect(childStartCode).toBe(0);
  expect(childStopCode).toBe(0);

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you', lastMsg: 'needs permission' },
    result: null,
  });

  expect(message).toMatchObject({ session: id, status: 'delivered' });
  expect(message['answer']).toBeUndefined();
});

test('it drops a hook line without an agent at a session whose own hooks carry one', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const child = Bun.spawn([...atcCommand, 'hook-report'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'nested-codex-1',
        last_assistant_message: 'nested codex output',
      }),
    ),
    env: collectEnv({ HOME: ctx.home, ATC_SESSION_ID: id, ATC_SOCKET: join(ctx.home, 'atc.sock') }),
  });

  const childCode = await child.exited;
  const record = await client.sendRequest('session.get', { session: id });

  expect(childCode).toBe(0);

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you' },
    result: null,
  });
});

test.each(['resume', 'clear', 'compact'])(
  'it rebinds a claude session to the agent session its own %s starts',
  async (source) => {
    const ctx = setupDaemonProc();

    const client = await ctx.openClient();

    const events: EventMsg[] = [];

    client.onEvent = (e) => {
      events.push(e);
    };

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await waitForEvent(
      events,
      (e) =>
        e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
    );

    const own = Bun.spawn([...atcCommand, 'hook-report', '--agent', 'claude'], {
      stdin: new TextEncoder().encode(
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-2', source }),
      ),
      env: collectEnv({
        HOME: ctx.home,
        ATC_SESSION_ID: id,
        ATC_SOCKET: join(ctx.home, 'atc.sock'),
      }),
    });

    const ownCode = await own.exited;

    expect(ownCode).toBe(0);

    await waitFor(async () => {
      const record = await client.sendRequest('session.get', { session: id });

      expect(record).toMatchObject({ session: { agentSessionID: 'fake-2' } });
    });
  },
);

test('it binds a gateway session through the hook command atc wrote for it', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24, agent: 'zai' });

  const started = await waitForEvent(
    events,
    (e) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  expect(started).toMatchObject({ session: { agent: 'zai', agentSessionID: 'fake-1' } });
});

test('it binds a session from a hook line without an agent while none of its own carried one', async () => {
  const ctx = setupDaemonProc();

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  const client = await ctx.openClient();

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    agent: 'grok',
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const reporter = Bun.spawn([...atcCommand, 'hook-report'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hookEventName: 'session_start', sessionId: 'fake-grok-1' }),
    ),
    env: collectEnv({ HOME: ctx.home, ATC_SESSION_ID: id, ATC_SOCKET: join(ctx.home, 'atc.sock') }),
  });

  const code = await reporter.exited;

  expect(code).toBe(0);

  await waitFor(async () => {
    const record = await client.sendRequest('session.get', { session: id });

    expect(record).toMatchObject({ session: { agent: 'grok', agentSessionID: 'fake-grok-1' } });
  });
});

test('it prints the running daemon id through atc daemon id', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();
  const hello = await client.sendHello('atc/test');

  const printed = Bun.spawnSync([...atcCommand, 'daemon', 'id'], {
    env: collectEnv({ HOME: ctx.home, XDG_RUNTIME_DIR: ctx.home }),
  });

  expect(printed.stdout.toString()).toBe(`${getString(hello, 'daemonID')}\n`);
});

test('it exits nonzero from atc daemon id when no daemon answers', () => {
  const home = mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const printed = Bun.spawnSync([...atcCommand, 'daemon', 'id'], {
    env: collectEnv({ HOME: home, XDG_RUNTIME_DIR: home }),
  });

  expect(printed.exitCode).toBe(1);
  expect(printed.stderr.toString()).toInclude('atc daemon id: no daemon at');
});

test.each([
  [['--listen', '0.0.0.0:8415', '--token-file', '/dev/null'], "--listen refuses '0.0.0.0'"],
  [['--listen', '127.0.0.1:8415'], '--listen and --token-file go together'],
])('it refuses to start a daemon with %j', (args, message) => {
  const home = mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const started = Bun.spawnSync([...atcCommand, 'daemon', ...args], {
    env: collectEnv({ HOME: home, XDG_RUNTIME_DIR: home }),
  });

  expect(started.exitCode).toBe(1);
  expect(started.stderr.toString()).toInclude(message);
});

test('it refuses to start a daemon whose --listen port another socket holds, leaving no socket or record', () => {
  const home = mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));
  const tokenFile = join(home, 'gateway-token');
  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    held.stop(true);

    rmSync(home, { recursive: true, force: true });
  });

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

  const started = Bun.spawnSync(
    [...atcCommand, 'daemon', '--listen', `127.0.0.1:${held.port}`, '--token-file', tokenFile],
    { env: collectEnv({ HOME: home, XDG_RUNTIME_DIR: home }) },
  );

  expect(started.exitCode).toBe(1);

  expect(started.stderr.toString()).toBe(
    `atc daemon: --listen cannot bind 127.0.0.1:${held.port} (EADDRINUSE)\n`,
  );

  expect(existsSync(join(home, 'atc-daemon.sock'))).toBeFalse();
  expect(existsSync(join(home, '.local', 'state', 'atc', 'daemon.json'))).toBeFalse();
});

test('it closes a TCP connection whose token a SIGHUP reload removed', async () => {
  const tokens = mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-tokens-'));
  const tokenFile = join(tokens, 'gateway-token');

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`);

  onTestFinished(() => {
    rmSync(tokens, { recursive: true, force: true });
  });

  // Port 0 leaves the pick to the kernel, which holds the port from the
  // bind on; a port the test picked and freed could be taken by another
  // socket before the daemon binds it. A hello answered over the unix
  // socket means startup has returned: the TCP listener is bound, the
  // record holds its port, and the SIGHUP handler is in place.
  const ctx = setupDaemonProc(undefined, {}, [
    '--listen',
    '127.0.0.1:0',
    '--token-file',
    tokenFile,
  ]);

  const local = await ctx.openClient();

  await local.sendHello('atc/test');

  const record = findDaemonRecord(join(ctx.home, '.local', 'state', 'atc', 'daemon.json'));

  if (record === null || record.listenPort === null) {
    throw new Error('daemon.json holds no listen port');
  }

  const port = record.listenPort;

  const tcp = await DaemonClient.open({ hostname: '127.0.0.1', port });

  const closed = Promise.withResolvers<void>();

  onTestFinished(() => {
    tcp.stop();
  });

  tcp.onClose = () => {
    closed.resolve();
  };

  await tcp.sendHello('atc/test-gateway', 'a'.repeat(32));

  writeFileSync(tokenFile, `${'b'.repeat(32)}\n`);

  ctx.proc.kill('SIGHUP');

  await closed.promise;

  const fresh = await DaemonClient.open({ hostname: '127.0.0.1', port });

  onTestFinished(() => {
    fresh.stop();
  });

  const hello = await fresh.sendHello('atc/test-gateway', 'b'.repeat(32));

  expect(hello).toContainKey('daemonID');
});

// A compiled binary loads no .env file from its working directory, while the
// source entry keeps Bun's runtime autoload, so these run on the binary only.
// With no daemon running, `daemon id` prints the socket path it tried, which
// follows XDG_RUNTIME_DIR and so shows whether a variable reached the process.
const isCompiledRun = process.env['ATC_BIN'] !== undefined;

test.skipIf(!isCompiledRun)(
  'it ignores a .env file in the working directory of the compiled binary',
  async () => {
    const dir = setupDotenvDir();
    const env = collectEnv({ HOME: dir });

    delete env['XDG_RUNTIME_DIR'];

    const result = await runDaemonID(dir, env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toInclude(join(dir, '.local', 'state', 'atc', 'atc-daemon.sock'));
    expect(result.stderr).not.toInclude('from-dotenv');
  },
);

test.skipIf(!isCompiledRun)(
  'it keeps an explicitly inherited variable in the compiled binary',
  async () => {
    const dir = setupDotenvDir();
    const explicit = join(dir, 'from-process-env');
    const env = collectEnv({ HOME: dir, XDG_RUNTIME_DIR: explicit });

    const result = await runDaemonID(dir, env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toInclude(join(explicit, 'atc-daemon.sock'));
  },
);

// A fresh directory holding a .env file whose only line points
// XDG_RUNTIME_DIR at a sentinel path, removed when the test ends.
function setupDotenvDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-dotenv-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(join(dir, '.env'), `XDG_RUNTIME_DIR=${join(dir, 'from-dotenv')}\n`);

  return dir;
}

// Runs `daemon id` in the directory with exactly the given environment.
async function runDaemonID(
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([...atcCommand, 'daemon', 'id'], {
    cwd,
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();

  return { exitCode: await proc.exited, stderr };
}
