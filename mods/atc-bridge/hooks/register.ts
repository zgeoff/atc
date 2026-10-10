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
    'While you work on a message that takes more than a quick answer, call the note tool at each milestone:',
    'when you find the cause, when you start a change, when you are blocked, or when you need a decision.',
    "Each note goes to atc's event feed as you send it.",
  ].join(' '),
} as const;

const NOTE_TOOL = 'mcp__atc-bridge__note';
const NOTE_LABELS = ['progress', 'blocked', 'decision'] as const;

/**
 * Delivers the atc inbox of the session named by ATC_SESSION_ID into the
 * conversation and serves the note tool. When a turn ends, it reports the
 * turn's final reply, with the turn's id, as the answer to every message the
 * turn carried. Outside atc it changes nothing.
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
        name: 'note',
        description:
          "Add a short note to atc's event feed while you keep working, so a reader of the feed sees progress before your final reply. Use it at milestones: when you find the cause, start a change, get blocked or need a decision. It does not answer a message or reach its sender directly. Your final reply goes out by itself, so do not repeat it here.",
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What the note says.' },
            label: {
              type: 'string',
              enum: [...NOTE_LABELS],
              description: 'progress (the default), blocked or decision',
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

  on('tool.call', { tool: NOTE_TOOL }, async ($, e) => {
    const text = typeof e['text'] === 'string' ? e['text'].trim() : '';
    const label = typeof e['label'] === 'string' ? e['label'].trim() : 'progress';

    if (text === '') {
      return { deny: 'note needs non-empty text' };
    }

    if (!isNoteLabel(label)) {
      return {
        deny: `note label must be ${NOTE_LABELS.slice(0, -1).join(', ')} or ${NOTE_LABELS.at(-1)}`,
      };
    }

    try {
      await $.process.run([...ATC_CLI, 'note', '--label', label], {
        stdin: text,
        timeoutMs: 5000,
      });
    } catch (error) {
      return { deny: `atc did not take the note: ${String(error)}` };
    }

    return { result: 'Sent to the user through atc.' };
  });
};

function isNoteLabel(value: string): value is (typeof NOTE_LABELS)[number] {
  return (NOTE_LABELS as readonly string[]).includes(value);
}

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

  const answered: string[] = [];

  for (const msg of carried) {
    if (state.unseen.delete(msg.id)) {
      scheduleDelivery($, state, msg);
    } else if (isAnswered) {
      answered.push(msg.id);
    }
  }

  // One answer carries every message the turn answered, so atc records the
  // whole group at once and no member reads as answered before the rest.
  if (answered.length > 0) {
    scheduleAnsweredReport($, state, answered, turnID, answer);
  }
}

function scheduleAnsweredReport(
  $: EngineInterface,
  state: BridgeState,
  messageIDs: readonly string[],
  turnID: string,
  answer: string,
): void {
  state.reporting = state.reporting
    .then(async () => {
      await $.process.run(
        [...ATC_CLI, 'answer', '--messages', messageIDs.join(','), '--turn', turnID],
        {
          stdin: answer,
          timeoutMs: 5000,
        },
      );
    })
    .catch((error: unknown) => {
      $.ui.log(`atc-bridge: reporting ${messageIDs.join(', ')} failed (${String(error)})`, {
        to: 'debug',
      });
    });
}
