// Stages the demo fleet, runs vhs on the tape, and moves the fleet on at each
// beat, once a daemon event proves the last one landed. The header of
// docs/assets/demo.tape gives the design. `kill-all <socket>` ends a daemon's sessions.
import { isRecord } from '@atc/core';
import { openDaemonClient } from '@atc/protocol/client';
import { DAEMON_EVENT_SCHEMA, SESSION_DESCRIPTOR_SCHEMA } from '@atcx/contract';
import type { SessionDescriptor } from '@atcx/contract';
import { z } from 'zod';
import { createHostServices } from '../packages/app/src/daemon/create-host-services';

type DaemonClient = Awaited<ReturnType<typeof openDaemonClient>>;

type DaemonEvent = z.output<typeof DAEMON_EVENT_SCHEMA>;

type Check = () => Promise<boolean> | boolean;

// What the beats wait on: every event from both daemons, and whether vhs
// has exited, with one wake-up for the step waiting now.
interface Watch {
  readonly events: DaemonEvent[];
  vhsExited: boolean;
  wake: () => void;
}

interface RecordingOptions {
  readonly localSocket: string;
  readonly cloudSocket: string;
  readonly localProject: string;
  readonly cloudProject: string;
  readonly tape: string;
}

const SESSION_LIST_SCHEMA = z.object({ sessions: z.array(SESSION_DESCRIPTOR_SCHEMA) });

// vhs takes its time to start a browser and type, so a step that waits on the
// tape gets longer than a step the daemons answer.
const STEP_TIMEOUT_MS = 30_000;
const TAPE_TIMEOUT_MS = 120_000;

// The viewer's time to read the list before the builders join it, and to
// read the two builders before one of them needs you.
const LIST_HOLD_MS = 1000;
const BUILDERS_HOLD_MS = 3000;
const [mode = '', ...args] = process.argv.slice(2);

if (mode === 'record' && args.length === 5) {
  const [localSocket = '', cloudSocket = '', localProject = '', cloudProject = '', tape = ''] =
    args;

  process.exitCode = await runRecording({
    localSocket,
    cloudSocket,
    localProject,
    cloudProject,
    tape,
  });
} else if (mode === 'kill-all' && args.length === 1) {
  await removeSessions(args[0] ?? '');
} else {
  console.error(
    'usage: drive-demo.ts record <local socket> <cloud socket> <local project> <cloud project> <tape> | kill-all <socket>',
  );

  process.exitCode = 2;
}

async function runRecording(options: RecordingOptions): Promise<number> {
  const watch: Watch = { events: [], vhsExited: false, wake: () => {} };

  const local = await openWatchedClient(options.localSocket, watch);
  const cloud = await openWatchedClient(options.cloudSocket, watch);

  try {
    const orchestrator = await runStaging(local, cloud, options, watch);

    return await runTape(options.tape, watch, async () => {
      await runBeats(local, orchestrator, watch);
    });
  } finally {
    local.stop();
    cloud.stop();
  }
}

async function openWatchedClient(socket: string, watch: Watch): Promise<DaemonClient> {
  const client = await openDaemonClient(socket);

  client.onEvent = (event) => {
    const parsed = DAEMON_EVENT_SCHEMA.safeParse(event);

    if (parsed.success && parsed.data.ev !== 'SessionOutput') {
      watch.events.push(parsed.data);
      watch.wake();
    }
  };

  await client.sendHello(createHostServices().build);

  return client;
}

// Two sessions on each daemon, staged before vhs starts, so the first frame
// of the list already holds them.
async function runStaging(
  local: DaemonClient,
  cloud: DaemonClient,
  options: RecordingOptions,
  watch: Watch,
): Promise<string> {
  const localProject = options.localProject;
  const cloudProject = options.cloudProject;

  const staged = [
    await spawnSession(
      local,
      localProject,
      'orchestrator',
      'plan the 2.0 release and start a builder for each part',
    ),
    await spawnSession(local, localProject, 'docs', 'write the 2.0 upgrade notes'),
    await spawnSession(cloud, cloudProject, 'flaky-test', 'find why the checkout test flakes'),
    await spawnSession(cloud, cloudProject, 'bench', 'profile the search endpoint'),
  ];

  await waitUntil(watch, 'every staged agent reports SessionStart', async () => {
    const localSessions = await readSessions(local);
    const cloudSessions = await readSessions(cloud);

    return isEveryAgentStarted([...localSessions, ...cloudSessions], staged);
  });

  return staged[0] ?? '';
}

// vhs runs in a process group of its own, so a stop takes its terminal
// server and browser down with it.
async function runTape(tape: string, watch: Watch, beats: () => Promise<void>): Promise<number> {
  const vhs = Bun.spawn(['setsid', 'vhs', tape], { stdio: ['ignore', 'inherit', 'inherit'] });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopProcessGroup(vhs.pid);

      process.exit(1);
    });
  }

  void watchExit(vhs, watch);

  try {
    await beats();
  } catch (error) {
    console.error(`drive-demo: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`drive-demo: the events so far: ${formatEvents(watch.events)}`);

    stopProcessGroup(vhs.pid);

    await vhs.exited;

    return 1;
  }

  return vhs.exited;
}

async function watchExit(vhs: Bun.Subprocess, watch: Watch): Promise<void> {
  await vhs.exited;

  watch.vhsExited = true;

  watch.wake();
}

async function runBeats(local: DaemonClient, orchestrator: string, watch: Watch): Promise<void> {
  await waitForTape(watch, 'the tape attaches the orchestrator', () =>
    hasEvent(watch.events, 'SessionAttached', orchestrator),
  );

  await waitForTape(watch, 'the tape opens the list over the orchestrator', () =>
    hasEvent(watch.events, 'SessionDetached', orchestrator),
  );

  await Bun.sleep(LIST_HOLD_MS);

  await runSend(orchestrator, 'start builders: api, ui');

  let builders: SessionDescriptor[] = [];

  await waitForDaemon(
    watch,
    'both builders report SessionStart under the orchestrator',
    async () => {
      const sessions = await readSessions(local);

      builders = collectStartedChildren(sessions, orchestrator);

      return builders.length === 2;
    },
  );

  await Bun.sleep(BUILDERS_HOLD_MS);

  const asked = builders.find((x) => x.name === 'builder-ui');

  if (asked === undefined) {
    throw new Error('the orchestrator started no builder-ui');
  }

  await runSend(asked.id, 'ask: Allow bun run migrate against the staging database?');

  await waitForDaemon(watch, 'builder-ui needs you', async () => {
    const sessions = await readSessions(local);

    return sessions.some((x) => x.id === asked.id && x.state === 'needs_you');
  });
}

async function waitForTape(watch: Watch, what: string, check: Check): Promise<void> {
  await waitUntil(watch, what, makeVHSCheck(watch, what, check), TAPE_TIMEOUT_MS);
}

async function waitForDaemon(watch: Watch, what: string, check: Check): Promise<void> {
  await waitUntil(watch, what, makeVHSCheck(watch, what, check), STEP_TIMEOUT_MS);
}

// A beat fails at once when vhs has already exited, since no later frame can
// show it.
function makeVHSCheck(watch: Watch, what: string, check: Check): Check {
  return () => {
    if (watch.vhsExited) {
      throw new Error(`vhs exited before ${what}`);
    }

    return check();
  };
}

// The check runs once at the start and again after each event, so a state
// reached before the wait began still ends it. The wake-up is in place before
// each check, so an event that lands during the check is never missed.
async function waitUntil(
  watch: Watch,
  what: string,
  check: Check,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;

  for (;;) {
    const woken = Promise.withResolvers<void>();

    watch.wake = woken.resolve;

    const done = await check();

    if (done) {
      return;
    }

    const remainingMs = deadlineMs - Date.now();

    if (remainingMs <= 0) {
      throw new Error(`timed out waiting until ${what}`);
    }

    const timer = setTimeout(woken.resolve, remainingMs);

    await woken.promise;

    clearTimeout(timer);
  }
}

function isEveryAgentStarted(
  sessions: readonly SessionDescriptor[],
  ids: readonly string[],
): boolean {
  return ids.every((id) => sessions.some((x) => x.id === id && x.agentSessionID !== undefined));
}

function collectStartedChildren(
  sessions: readonly SessionDescriptor[],
  parent: string,
): SessionDescriptor[] {
  return sessions.filter((x) => x.parent === parent && x.agentSessionID !== undefined);
}

function hasEvent(
  events: readonly DaemonEvent[],
  ev: 'SessionAttached' | 'SessionDetached',
  session: string,
): boolean {
  return events.some((x) => x.ev === ev && x.session.id === session);
}

function formatEvents(events: readonly DaemonEvent[]): string {
  return events.map((x) => ('session' in x ? `${x.ev}(${x.session.name})` : x.ev)).join(' ');
}

function stopProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
}

async function spawnSession(
  client: DaemonClient,
  cwd: string,
  name: string,
  prompt: string,
): Promise<string> {
  const ok = await client.sendRequest('session.spawn', { cwd, name, prompt, cols: 98, rows: 28 });

  const session = ok['session'];

  if (!isRecord(session) || typeof session['id'] !== 'string') {
    throw new Error(`the spawn of ${name} returned no session: ${JSON.stringify(ok)}`);
  }

  return session['id'];
}

async function readSessions(client: DaemonClient): Promise<SessionDescriptor[]> {
  const listed = await client.sendRequest('session.list');

  return SESSION_LIST_SCHEMA.parse(listed).sessions;
}

// The message goes out through `atc send`, the command a script runs.
async function runSend(session: string, text: string): Promise<void> {
  const send = Bun.spawn(['atc', 'send', session, text], { stdout: 'ignore', stderr: 'pipe' });

  const code = await send.exited;

  if (code !== 0) {
    const reason = await send.stderr.text();

    throw new Error(`atc send to ${session} exited ${code}: ${reason}`);
  }
}

async function removeSessions(socket: string): Promise<void> {
  const client = await openDaemonClient(socket);

  await client.sendHello(createHostServices().build);

  const sessions = await readSessions(client);

  for (const session of sessions) {
    if (session.alive && session.parent === undefined) {
      await client.sendRequest('session.kill', { session: session.id });
    }
  }

  client.stop();
}
