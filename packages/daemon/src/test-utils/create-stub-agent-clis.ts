import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, toAgentID } from '@atc/core';
import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';
import { normalizeHookEventName } from '@atc/protocol/session';
import type { HookEvent } from '@atc/protocol/session';
import { toSessionID } from '@atcx/contract';
import { SESSION_ENV_NAMES } from '@atcx/contract/light';
import type { Socket } from 'bun';
import type { StubMemoryHarness } from './build-stub-memory-provider';

type StubAgentKind = 'claude' | 'grok' | 'codex';

interface StubAgentSession {
  readonly kind: StubAgentKind;
  readonly harness: StubMemoryHarness;

  readonly received: string[];

  readonly report: (payload: Readonly<Record<string, unknown>>) => Promise<boolean>;
}

interface StubAgentCLIs {
  readonly bins: Readonly<Record<StubAgentKind, string>>;

  readonly sessions: StubAgentSession[];

  readonly start: (harness: StubMemoryHarness) => void;

  readonly holdStart: (kind: StubAgentKind) => void;

  readonly loadEvents: (
    kind: StubAgentKind,
    events: readonly Readonly<Record<string, unknown>>[],
  ) => void;

  readonly useOwnID: () => void;
}

interface StubAgentScript {
  held: boolean;
  events: readonly Readonly<Record<string, unknown>>[] | null;
  ownID: boolean;
}

const NEVER_RUNS = '#!/bin/sh\necho "the stand-in agent runs in the test process" >&2\nexit 1\n';

export function createStubAgentCLIs(directory: string): StubAgentCLIs {
  const bins: Record<StubAgentKind, string> = {
    claude: writeStubProgram(directory, 'claude', NEVER_RUNS),
    grok: writeStubProgram(directory, 'grok', NEVER_RUNS),
    codex: writeStubProgram(directory, 'codex', NEVER_RUNS),
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

      if (typeof rawName !== 'string') {
        return Promise.resolve(false);
      }

      const line: HookEvent = {
        atcId: toSessionID(atcID),
        agent: toAgentID(agent),
        event: normalizeHookEventName(rawName),
        payload,
      };

      return writeReportLine(socket, `${JSON.stringify(line)}\n`).then(
        () => true,
        () => false,
      );
    },
  };
}

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

// A socket write takes only what fits in its buffer, so the rest must go out on drain.
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

  const prompt =
    session.kind === 'claude' && script.ownID && atcID !== undefined
      ? { ...DEFAULT_PROMPTS.claude, session_id: atcID }
      : DEFAULT_PROMPTS[session.kind];

  for (const event of script.events ?? [prompt]) {
    await session.report(event);
  }
}
