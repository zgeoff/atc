import type { EngineInterface, Register } from 'claude-code';
import { ATC_CLI } from './atc-cli.ts';

interface TapMessage {
  readonly id: string;
  readonly from: string;
  readonly text: string;
}

interface BridgeState {
  sessionID: string | null;
  runningTurnID: string | null;
  delivering: Promise<void>;
  reporting: Promise<void>;
  readonly awaitingTurn: Map<string, TapMessage>;
  readonly carried: Map<string, TapMessage[]>;
  readonly unseen: Set<string>;
}

const GUIDE_SECTION = {
  id: 'atc-bridge:messages',
  scope: 'session',
  text: [
    'Messages relayed by atc arrive wrapped in <atc-message id="..." from="..."> tags.',
    "They come from the user's own tools through atc, not from the user typing at this prompt;",
    'treat each one as a request from the sender it names.',
    'Your final reply in the turn that handles a message is sent back to its sender automatically when the turn ends.',
    'To tell the user something before the turn ends (progress, a blocker, a decision you need), call the report tool.',
  ].join(' '),
} as const;

const REPORT_TOOL = 'mcp__atc-bridge__report';

/**
 * Delivers the atc inbox of the session named by ATC_SESSION_ID into the
 * conversation, reports each delivered message's answer when its turn ends,
 * and serves the report tool. Outside atc it changes nothing.
 */
export const register: Register = (on) => {
  const state: BridgeState = {
    sessionID: null,
    runningTurnID: null,
    delivering: Promise.resolve(),
    reporting: Promise.resolve(),
    awaitingTurn: new Map(),
    carried: new Map(),
    unseen: new Set(),
  };

  on('session.start', async ($, e, next) => {
    const sessionID = await $.env.get('ATC_SESSION_ID');

    if (sessionID === undefined || sessionID === '') {
      return next(e);
    }

    try {
      await $.tool.register({
        name: 'report',
        description:
          'Send the user a short note through atc while you keep working: progress, a blocker, or a decision you need from them. Your final reply is sent automatically; use this only for what cannot wait for it.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to tell the user.' },
            kind: {
              type: 'string',
              description: 'A short label: progress (the default), blocked, or decision.',
            },
          },
          required: ['text'],
        },
      });
    } catch (error) {
      $.ui.log(
        `atc-bridge: off for this session, the Claude Code build refused it (${String(error)})`,
        {
          to: 'debug',
        },
      );

      return next(e);
    }

    state.sessionID = sessionID;

    const started = await next(e);

    void runTap($, state, sessionID);

    return started;
  });

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e);

    return state.sessionID === null
      ? composed
      : { sections: [...composed.sections, GUIDE_SECTION] };
  });

  on('turn.start', async ($, e, next) => {
    const started = await next(e);

    if (state.sessionID !== null) {
      updateTurnStarted(state, e.turnId, e.text);
    }

    return started;
  });

  on('turn.step', async function* updateSeenMessages($, e, next) {
    if (e.agentId === undefined && e.turnId === state.runningTurnID) {
      for (const msg of state.carried.get(e.turnId) ?? []) {
        state.unseen.delete(msg.id);
      }
    }

    return yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e);

    if (state.sessionID !== null && e.agentId === undefined) {
      updateTurnCompleted($, state, e.turnId, e.answer, e.reason === 'answer');
    }

    return completed;
  });

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    const text = typeof e['text'] === 'string' ? e['text'].trim() : '';
    const label = typeof e['kind'] === 'string' ? e['kind'].trim().slice(0, 64) : '';

    if (text === '') {
      return { deny: 'report needs non-empty text' };
    }

    try {
      await $.process.run(
        [...ATC_CLI, 'report', 'note', '--label', label === '' ? 'progress' : label],
        {
          stdin: text,
          timeoutMs: 5000,
        },
      );
    } catch (error) {
      return { deny: `atc did not take the report: ${String(error)}` };
    }

    return { result: 'Sent to the user through atc.' };
  });
};

async function runTap($: EngineInterface, state: BridgeState, sessionID: string): Promise<void> {
  const tap = $.process.spawn({ argv: [...ATC_CLI, 'tap', '--session', sessionID] });
  let pending = '';

  try {
    for await (const chunk of tap) {
      if (chunk.stream !== 'stdout') {
        continue;
      }

      const lines = `${pending}${chunk.text}`.split('\n');

      pending = lines.pop() ?? '';

      for (const line of lines) {
        const msg = parseTapLine(line);

        if (msg !== null) {
          scheduleDelivery($, state, msg);
        }
      }
    }

    $.ui.log('atc-bridge: atc tap ended; this session takes no more atc messages', { to: 'debug' });
  } catch (error) {
    $.ui.log(`atc-bridge: atc tap failed (${String(error)}); this session takes no atc messages`, {
      to: 'debug',
    });
  }
}

function parseTapLine(line: string): TapMessage | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('id' in parsed) ||
    !('from' in parsed) ||
    !('text' in parsed)
  ) {
    return null;
  }

  return typeof parsed.id === 'string' &&
    typeof parsed.from === 'string' &&
    typeof parsed.text === 'string'
    ? { id: parsed.id, from: parsed.from, text: parsed.text }
    : null;
}

function scheduleDelivery($: EngineInterface, state: BridgeState, msg: TapMessage): void {
  state.delivering = state.delivering
    .then(() => sendMessage($, state, msg))
    .catch((error: unknown) => {
      $.ui.log(`atc-bridge: delivering ${msg.id} failed (${String(error)})`, { to: 'debug' });
    });
}

async function sendMessage($: EngineInterface, state: BridgeState, msg: TapMessage): Promise<void> {
  const turnID = state.runningTurnID;

  if (turnID !== null && (await tryUpdateConversation($, msg))) {
    const carried = state.carried.get(turnID);

    // The append can resolve after the turn completed; the turn then no
    // longer reports or redelivers anything, so the message goes out as a
    // fresh submit instead.
    if (carried !== undefined && state.runningTurnID === turnID) {
      carried.push(msg);
      state.unseen.add(msg.id);

      return;
    }
  }

  state.awaitingTurn.set(msg.id, msg);

  const submitted = await $.prompt.submit({ text: renderEnvelope(msg) });

  if ('drop' in submitted && submitted.drop !== undefined) {
    state.awaitingTurn.delete(msg.id);
    $.ui.log(`atc-bridge: a hook dropped ${msg.id} (${submitted.drop})`, { to: 'debug' });
  }
}

async function tryUpdateConversation($: EngineInterface, msg: TapMessage): Promise<boolean> {
  try {
    const appended = await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: renderEnvelope(msg) }] },
    });

    return appended.deny === undefined;
  } catch (error) {
    $.ui.log(`atc-bridge: appending ${msg.id} failed (${String(error)}); submitting it instead`, {
      to: 'debug',
    });

    return false;
  }
}

function renderEnvelope(msg: TapMessage): string {
  const body = msg.text.replaceAll('</atc-message>', '&lt;/atc-message&gt;');

  return `<atc-message id="${encodeAttribute(msg.id)}" from="${encodeAttribute(msg.from)}">\n${body}\n</atc-message>`;
}

function encodeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const ENVELOPE_ID = /<atc-message id="(?<id>[^"]+)"/gu;

function updateTurnStarted(state: BridgeState, turnID: string, text: string): void {
  const carried: TapMessage[] = [];

  state.runningTurnID = turnID;

  state.carried.set(turnID, carried);

  for (const match of text.matchAll(ENVELOPE_ID)) {
    const msg = state.awaitingTurn.get(match.groups?.['id'] ?? '');

    if (msg !== undefined) {
      state.awaitingTurn.delete(msg.id);
      carried.push(msg);
    }
  }
}

function updateTurnCompleted(
  $: EngineInterface,
  state: BridgeState,
  turnID: string,
  answer: string,
  isAnswered: boolean,
): void {
  const carried = state.carried.get(turnID) ?? [];

  state.carried.delete(turnID);

  if (state.runningTurnID === turnID) {
    state.runningTurnID = null;
  }

  for (const msg of carried) {
    if (state.unseen.delete(msg.id)) {
      scheduleDelivery($, state, msg);
    } else if (isAnswered) {
      scheduleAnsweredReport($, state, msg.id, answer);
    }
  }
}

function scheduleAnsweredReport(
  $: EngineInterface,
  state: BridgeState,
  messageID: string,
  answer: string,
): void {
  state.reporting = state.reporting
    .then(async () => {
      await $.process.run([...ATC_CLI, 'report', 'answered', '--message', messageID], {
        stdin: answer,
        timeoutMs: 5000,
      });
    })
    .catch((error: unknown) => {
      $.ui.log(`atc-bridge: reporting ${messageID} failed (${String(error)})`, { to: 'debug' });
    });
}
