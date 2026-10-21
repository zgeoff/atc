import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import { SESSION_ENV_NAMES, normalizeHookEventName } from '@atc/protocol/session';
import { createStubBin } from '@atc/test-utils';
import type { Socket } from 'bun';
import type { StubMemoryHarness } from './build-stub-memory-provider';

type StubAgentKind = 'claude' | 'grok' | 'codex';

interface StubAgentSession {
  readonly kind: StubAgentKind;
  readonly harness: StubMemoryHarness;

  // Each line the session read from its terminal, without its line end.
  readonly received: string[];

  // Reports one hook event as the agent's hook command reports it. Like the
  // reporter, it never throws: it resolves true once the daemon's socket
  // took the whole line, and false when the socket refused it.
  readonly report: (payload: Readonly<Record<string, unknown>>) => Promise<boolean>;
}

interface StubAgentCLIs {
  // The executables a config names for each agent. They never run: the
  // daemon's in-memory provider hands each spawn of one to the stand-in.
  readonly bins: Readonly<Record<StubAgentKind, string>>;

  // Every session the stand-in started, in order.
  readonly sessions: StubAgentSession[];

  // Runs the stand-in on a harness the daemon started.
  readonly start: (harness: StubMemoryHarness) => void;

  // The next session of the agent paints its banner and reports nothing,
  // as an agent that has not started up yet.
  readonly holdStart: (kind: StubAgentKind) => void;

  // The next session of the agent reports these events after its start, in
  // place of its permission prompt.
  readonly loadEvents: (
    kind: StubAgentKind,
    events: readonly Readonly<Record<string, unknown>>[],
  ) => void;

  // The next Claude session reports the daemon's own session id as its
  // agent session id, as a session that atc resumes under its own id does.
  readonly useOwnID: () => void;
}

// Each next session's script, which a start takes and clears.
interface StubAgentScript {
  held: boolean;
  events: readonly Readonly<Record<string, unknown>>[] | null;
  ownID: boolean;
}

const NEVER_RUNS = '#!/bin/sh\necho "the stand-in agent runs in the test process" >&2\nexit 1\n';

export function createStubAgentCLIs(directory: string): StubAgentCLIs {
  const bins: Record<StubAgentKind, string> = {
    claude: createStubBin(directory, 'claude', NEVER_RUNS),
    grok: createStubBin(directory, 'grok', NEVER_RUNS),
    codex: createStubBin(directory, 'codex', NEVER_RUNS),
  };

  const sessions: StubAgentSession[] = [];

  const scripts: Record<StubAgentKind, StubAgentScript> = {
    claude: { held: false, events: null, ownID: false },
    grok: { held: false, events: null, ownID: false },
    codex: { held: false, events: null, ownID: false },
  };

  return {
    bins,
    sessions,
    start: (harness) => {
      const kind = (['claude', 'grok', 'codex'] as const).find(
        (candidate) => bins[candidate] === harness.spec.bin,
      );

      if (kind === undefined) {
        throw new Error(`the stand-in runs no agent at ${harness.spec.bin}`);
      }

      const script = { ...scripts[kind] };

      scripts[kind] = { held: false, events: null, ownID: false };

      const session = createStubAgentSession(kind, harness);

      sessions.push(session);

      runStubAgent(session, script, directory);
    },
    holdStart: (kind) => {
      scripts[kind].held = true;
    },
    loadEvents: (kind, events) => {
      scripts[kind].events = events;
    },
    useOwnID: () => {
      scripts.claude.ownID = true;
    },
  };
}

function createStubAgentSession(kind: StubAgentKind, harness: StubMemoryHarness): StubAgentSession {
  const received: string[] = [];
  const env = harness.spec.env;
  const socket = env[SESSION_ENV_NAMES.socket];
  const atcID = env[SESSION_ENV_NAMES.sessionID];
  const agent = kind === 'claude' ? readClaudeHookAgent(harness.spec.args) : kind;
  let pending = '';

  harness.onInput((data) => {
    pending += data;

    const lines = pending.split(/\r\n?|\n/u);

    pending = lines.pop() ?? '';

    for (const line of lines) {
      received.push(line);

      if (kind === 'claude') {
        harness.emitData(`GOT:${line}\r\n`);
      }
    }
  });

  return {
    kind,
    harness,
    received,
    report: (payload) => {
      if (socket === undefined || atcID === undefined) {
        return Promise.resolve(false);
      }

      const rawName = payload['hook_event_name'] ?? payload['hookEventName'];
      const event = typeof rawName === 'string' ? normalizeHookEventName(rawName) : rawName;

      return writeReportLine(
        socket,
        `${JSON.stringify({ atcId: atcID, agent, event, payload })}\n`,
      ).then(
        () => true,
        () => false,
      );
    },
  };
}

// The agent id the hook command in a Claude launch's settings file passes
// to its reporter, as the reporter would read it.
function readClaudeHookAgent(args: readonly string[]): string {
  const settingsPath = args[args.indexOf('--settings') + 1];

  if (settingsPath === undefined) {
    throw new Error('the Claude launch names no settings file');
  }

  const settings: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const hooks = isRecord(settings) ? settings['hooks'] : null;
  const command = JSON.stringify(hooks);
  const agent = /hook-report --agent=(?<agent>[^\s"\\]+)/u.exec(command)?.groups?.['agent'];

  if (agent === undefined) {
    throw new Error(`the settings file at ${settingsPath} holds no hook command`);
  }

  return agent.replaceAll("'", '');
}

// Sends one line to the reporter socket the way the hook reporter does: a
// write takes only what fits, and the rest goes out as the socket drains.
async function writeReportLine(socket: string, line: string): Promise<void> {
  const bytes = Buffer.from(line);
  const closed = Promise.withResolvers<void>();
  let sent = 0;

  const sendRemainder = (connection: Socket) => {
    sent += connection.write(bytes.subarray(sent));

    if (sent === bytes.length) {
      connection.end();
    }
  };

  await Bun.connect({
    unix: socket,
    socket: {
      open: sendRemainder,
      drain: sendRemainder,
      close() {
        closed.resolve();
      },
      data() {},
      error(_connection, error) {
        closed.reject(error);
      },
    },
  });

  await closed.promise;
}

// Paints the agent's banner after the spawn returns, reports its start, then
// its prompt or the loaded events, as each stand-in CLI script does.
function runStubAgent(session: StubAgentSession, script: StubAgentScript, home: string): void {
  const spec = session.harness.spec;

  setTimeout(() => {
    if (session.harness.readExit() !== null || session.harness.isDetached()) {
      return;
    }

    session.harness.emitData(
      `FAKE_${session.kind.toUpperCase()}_UP args: ${spec.args.join(' ')}\r\n`,
    );

    if (script.held) {
      return;
    }

    void reportStart(session, script, home);
  }, 0);
}

const DEFAULT_PROMPTS: Readonly<Record<StubAgentKind, Readonly<Record<string, unknown>>>> = {
  claude: { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  grok: {
    hookEventName: 'notification',
    sessionId: 'fake-grok-1',
    notificationType: 'permission_prompt',
    message: 'allow edit?',
  },
  codex: { hook_event_name: 'Stop', session_id: 'fake-codex-1', last_assistant_message: 'pong' },
};

async function reportStart(
  session: StubAgentSession,
  script: StubAgentScript,
  home: string,
): Promise<void> {
  const spec = session.harness.spec;
  const atcID = spec.env[SESSION_ENV_NAMES.sessionID];

  if (session.kind === 'claude') {
    await session.report({
      hook_event_name: 'SessionStart',
      session_id: script.ownID && atcID !== undefined ? atcID : 'fake-1',
      transcript_path: join(home, 'fake-transcript.jsonl'),
    });
  } else if (session.kind === 'grok') {
    await session.report({
      hookEventName: 'session_start',
      sessionId: 'fake-grok-1',
      cwd: spec.cwd,
    });
  } else {
    await session.report({
      hook_event_name: 'SessionStart',
      session_id: 'fake-codex-1',
      transcript_path: join(home, 'fake-rollout.jsonl'),
      cwd: spec.cwd,
      source: 'startup',
    });
  }

  // A report the daemon refused leaves the next one to try, as each hook
  // runs its own reporter.
  const prompt =
    session.kind === 'claude' && script.ownID && atcID !== undefined
      ? { ...DEFAULT_PROMPTS.claude, session_id: atcID }
      : DEFAULT_PROMPTS[session.kind];

  for (const event of script.events ?? [prompt]) {
    await session.report(event);
  }
}
