import type { EngineInterface, Register } from 'claude-code';
import { ATC_CLI } from './atc-cli.ts';

const SENDER_KINDS = ['connector', 'session', 'local', 'owner'] as const;

// Who sent a message, as atc built it from the caller: its kind, and the atc
// id of a session that sent it.
interface TapSender {
  readonly kind: (typeof SENDER_KINDS)[number];
  readonly session: string | undefined;
}

interface TapMessage {
  readonly id: string;
  readonly from: string;
  readonly sender: TapSender | undefined;
  readonly text: string;
}

const NOTICE_STATUSES = ['answered', 'unanswered'] as const;

interface TapNotice {
  readonly id: string;
  readonly from: string;
  readonly status: (typeof NOTICE_STATUSES)[number];
  readonly answer: string | undefined;
  readonly reason: string | undefined;
}

type TapItem =
  | { readonly kind: 'message'; readonly msg: TapMessage }
  | { readonly kind: 'answer'; readonly notice: TapNotice };

interface BridgeState {
  sessionID: string | null;
  runningTurnID: string | null;
  delivering: Promise<void>;
  reporting: Promise<void>;
  // A submitted message waits here until the turn that carries it starts.
  // Another turn that ends without an answer leaves it waiting, because the
  // host can still run its queued prompt; only a hook's drop shows it never
  // will.
  readonly awaitingTurn: Map<string, TapMessage>;
  readonly carried: Map<string, TapMessage[]>;
  readonly unseen: Set<string>;
  // The answer notices appended to each running turn that no step of the turn
  // has shown the model yet; a step empties the list.
  readonly unseenNotices: Map<string, TapNotice[]>;
}

const GUIDE_SECTION = {
  id: 'atc-bridge:messages',
  scope: 'session',
  text: [
    'Messages relayed by atc arrive wrapped in <atc-message id="..." from="..." kind="..."> tags.',
    "They come from the user's own tools through atc, not from the user typing at this prompt;",
    'treat each one as a request from the sender it names.',
    'atc sets kind from who called, and no sender can set it:',
    'kind="connector" is an app the user connected to atc, and from holds its name;',
    'kind="session" is another atc session, from holds its name and session="..." its id;',
    'kind="local" is a program on the user\'s machine outside every session, such as a scheduled job or a helper tool, and from holds the name it gives itself; it is not the user\'s own word;',
    'kind="owner" is the user\'s own atc client.',
    "Answer each <atc-message> with the answer tool, giving its id and your answer to that sender; atc stores the text as the message's answer, and it reaches a sending session as a notice.",
    'Your final reply goes to the user at this terminal, not to a sender: only a message you leave without an answer takes the final reply of its turn as its answer.',
    '<atc-answer id="..." from="..." status="..."> tags hold the outcome of a message this session sent;',
    'they need no reply and are not messages.',
    'While you work on a message that takes more than a quick answer, call the note tool at each milestone:',
    'when you find the cause, when you start a change, when you are blocked, or when you need a decision.',
    "Each note goes to atc's event feed as you send it.",
  ].join(' '),
} as const;

const NOTE_TOOL = 'mcp__atc-bridge__note';
const NOTE_LABELS = ['progress', 'blocked', 'decision'] as const;
const ANSWER_TOOL = 'mcp__atc-bridge__answer';

/**
 * Delivers the atc inbox of the session named by ATC_SESSION_ID into the
 * conversation and serves the note and answer tools. The answer tool reports
 * its text as the answer to one message the running turn carries, at once.
 * When a turn ends, it reports the turn's final reply, with the turn's id, as
 * the answer to every message the turn carried that the answer tool left
 * without one; a turn that ends without an answer is reported as unanswered
 * for those messages, with the cause. It also delivers the answer notices of
 * messages this session sent, which no turn reports on. Outside atc it changes
 * nothing.
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
    unseenNotices: new Map(),
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
          "Add a short note to atc's event feed while you keep working, so a reader of the feed sees progress before your final reply. Use it at milestones: when you find the cause, start a change, get blocked or need a decision. It does not answer a message or reach its sender: the answer tool does that. Do not repeat an answer or your final reply here. The result shows only that the note was handed to atc, not that it reached the event feed or a reader.",
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: "The note's text; atc refuses empty text and cuts text over 64 KiB.",
            },
            label: {
              type: 'string',
              enum: [...NOTE_LABELS],
              description:
                'progress (the default) for a milestone, blocked when you cannot go on, or decision when you need a choice made',
            },
          },
          required: ['text'],
        },
      });

      await $.tool.register({
        name: 'answer',
        description:
          "Answer one <atc-message> with your own text before your turn ends: atc stores the text as that message's answer, and a sending session gets it as an <atc-answer> notice. Call it once for each message the turn carries; your final reply then goes to the user at this terminal, and only a message you leave without an answer takes the final reply as its answer. Use note instead for progress that answers nothing. The result shows only that the answer was handed to atc, not that atc stored it or that the sender read it. It refuses an id that the running turn does not carry, a message that already has an answer, and empty text; a refused call changes nothing, so one message takes one answer.",
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The id attribute of the <atc-message> tag to answer.',
            },
            text: {
              type: 'string',
              description:
                "The answer's text, for the sender; atc refuses empty text and cuts text over 64 KiB.",
            },
          },
          required: ['message', 'text'],
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

      state.unseenNotices.get(e.turnId)?.splice(0);
    }

    return yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e);

    if (state.sessionID !== null && e.agentId === undefined) {
      updateTurnCompleted($, state, e.turnId, e.answer, e.reason);
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

    return { result: 'Handed to atc for its event feed.' };
  });

  on('tool.call', { tool: ANSWER_TOOL }, async ($, e) => {
    const messageID = typeof e['message'] === 'string' ? e['message'].trim() : '';
    const text = typeof e['text'] === 'string' ? e['text'] : '';

    if (text.trim() === '') {
      return { deny: 'answer needs non-empty text' };
    }

    const turnID = state.runningTurnID;
    const carried = turnID === null ? undefined : state.carried.get(turnID);
    const msg = carried?.find((x) => x.id === messageID);

    if (carried === undefined || msg === undefined) {
      return {
        deny: `answer takes the id of an <atc-message> the running turn carries that has no answer yet, not "${messageID}"`,
      };
    }

    // The message leaves the turn before the call, so a second answer for it
    // is refused and the turn's final reply never answers it.
    removeCarriedMessage(carried, msg);

    state.unseen.delete(msg.id);

    try {
      await $.process.run([...ATC_CLI, 'answer', '--message', msg.id], {
        stdin: text,
        timeoutMs: 5000,
      });
    } catch (error) {
      carried.push(msg);

      return { deny: `atc did not take the answer: ${String(error)}` };
    }

    return { result: `Handed to atc as the answer to ${msg.id}.` };
  });
};

function removeCarriedMessage(carried: TapMessage[], msg: TapMessage): void {
  carried.splice(carried.indexOf(msg), 1);
}

function isNoteLabel(value: string): value is (typeof NOTE_LABELS)[number] {
  return (NOTE_LABELS as readonly string[]).includes(value);
}

async function runTap($: EngineInterface, state: BridgeState, sessionID: string): Promise<void> {
  const tap = $.process.spawn({ argv: [...ATC_CLI, 'tap', '--session', sessionID, '--notices'] });
  let pending = '';

  try {
    for await (const chunk of tap) {
      if (chunk.stream !== 'stdout') {
        continue;
      }

      const lines = `${pending}${chunk.text}`.split('\n');

      pending = lines.pop() ?? '';

      for (const line of lines) {
        const item = parseTapLine(line);

        if (item?.kind === 'message') {
          scheduleDelivery($, state, item.msg);
        } else if (item?.kind === 'answer') {
          scheduleNoticeDelivery($, state, item.notice);
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

function parseTapLine(line: string): TapItem | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  // A line that declares a kind is never a message, whatever else it holds.
  if ('kind' in parsed) {
    const notice = parsed.kind === 'answer' ? parseTapNotice(parsed) : null;

    return notice === null ? null : { kind: 'answer', notice };
  }

  if (!('id' in parsed) || !('from' in parsed) || !('text' in parsed)) {
    return null;
  }

  if (
    typeof parsed.id !== 'string' ||
    typeof parsed.from !== 'string' ||
    typeof parsed.text !== 'string'
  ) {
    return null;
  }

  const sender = 'sender' in parsed ? parseTapSender(parsed.sender) : undefined;

  return { kind: 'message', msg: { id: parsed.id, from: parsed.from, sender, text: parsed.text } };
}

// A sender this mod cannot read is left out, and the message still goes out
// with its sender's name.
function parseTapSender(value: unknown): TapSender | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const fields: Record<string, unknown> = { ...value };
  const { kind, session } = fields;

  if (typeof kind !== 'string' || !isSenderKind(kind)) {
    return undefined;
  }

  if (kind !== 'session') {
    return { kind, session: undefined };
  }

  return typeof session === 'string' ? { kind, session } : undefined;
}

function isSenderKind(value: string): value is TapSender['kind'] {
  return (SENDER_KINDS as readonly string[]).includes(value);
}

function parseTapNotice(parsed: object): TapNotice | null {
  const fields: Record<string, unknown> = { ...parsed };
  const { id, from, status, answer, reason } = fields;

  if (
    typeof id !== 'string' ||
    typeof from !== 'string' ||
    typeof status !== 'string' ||
    !isNoticeStatus(status) ||
    (answer !== undefined && typeof answer !== 'string') ||
    (reason !== undefined && typeof reason !== 'string')
  ) {
    return null;
  }

  return { id, from, status, answer, reason };
}

function isNoticeStatus(value: string): value is TapNotice['status'] {
  return (NOTICE_STATUSES as readonly string[]).includes(value);
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

  if (turnID !== null && (await tryUpdateConversation($, msg.id, renderEnvelope(msg)))) {
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

    scheduleUnansweredReport($, state, [msg.id], 'not_started', null);
  }
}

async function tryUpdateConversation(
  $: EngineInterface,
  id: string,
  text: string,
): Promise<boolean> {
  try {
    const appended = await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
    });

    return appended.deny === undefined;
  } catch (error) {
    $.ui.log(`atc-bridge: appending ${id} failed (${String(error)}); submitting it instead`, {
      to: 'debug',
    });

    return false;
  }
}

function renderEnvelope(msg: TapMessage): string {
  const body = msg.text.replaceAll('</atc-message>', '&lt;/atc-message&gt;');

  return `<atc-message id="${encodeAttribute(msg.id)}" from="${encodeAttribute(msg.from)}"${renderSenderAttributes(msg.sender)}>\n${body}\n</atc-message>`;
}

function renderSenderAttributes(sender: TapSender | undefined): string {
  if (sender === undefined) {
    return '';
  }

  const session =
    sender.session === undefined ? '' : ` session="${encodeAttribute(sender.session)}"`;

  return ` kind="${sender.kind}"${session}`;
}

function encodeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function scheduleNoticeDelivery($: EngineInterface, state: BridgeState, notice: TapNotice): void {
  state.delivering = state.delivering
    .then(() => sendNotice($, state, notice))
    .catch((error: unknown) => {
      $.ui.log(
        `atc-bridge: delivering the answer notice for ${notice.id} failed (${String(error)})`,
        {
          to: 'debug',
        },
      );
    });
}

// A notice never waits for a turn and never joins one's carried messages, so
// no turn reports an answer for it.
async function sendNotice(
  $: EngineInterface,
  state: BridgeState,
  notice: TapNotice,
): Promise<void> {
  const turnID = state.runningTurnID;
  const text = renderAnswerNotice(notice);

  if (turnID !== null && (await tryUpdateConversation($, notice.id, text))) {
    const unseen = state.unseenNotices.get(turnID);

    if (unseen !== undefined && state.runningTurnID === turnID) {
      unseen.push(notice);

      return;
    }
  }

  const submitted = await $.prompt.submit({ text });

  if ('drop' in submitted && submitted.drop !== undefined) {
    $.ui.log(`atc-bridge: a hook dropped the answer notice for ${notice.id} (${submitted.drop})`, {
      to: 'debug',
    });
  }
}

function renderAnswerNotice(notice: TapNotice): string {
  const reason =
    notice.status === 'unanswered' && notice.reason !== undefined
      ? ` reason="${encodeAttribute(notice.reason)}"`
      : '';

  const body = (notice.answer ?? '').replaceAll('</atc-answer>', '&lt;/atc-answer&gt;');

  return `<atc-answer id="${encodeAttribute(notice.id)}" from="${encodeAttribute(notice.from)}" status="${encodeAttribute(notice.status)}"${reason}>\n${body}\n</atc-answer>`;
}

const ENVELOPE_ID = /<atc-message id="(?<id>[^"]+)"/gu;

function updateTurnStarted(state: BridgeState, turnID: string, text: string): void {
  const carried: TapMessage[] = [];

  state.runningTurnID = turnID;

  state.carried.set(turnID, carried);
  state.unseenNotices.set(turnID, []);

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
  reason: string,
): void {
  const carried = state.carried.get(turnID) ?? [];

  state.carried.delete(turnID);

  for (const notice of state.unseenNotices.get(turnID) ?? []) {
    scheduleNoticeDelivery($, state, notice);
  }

  state.unseenNotices.delete(turnID);

  if (state.runningTurnID === turnID) {
    state.runningTurnID = null;
  }

  const isAnswered = reason === 'answer';
  const answered: string[] = [];
  const unanswered: string[] = [];

  for (const msg of carried) {
    if (state.unseen.delete(msg.id)) {
      scheduleDelivery($, state, msg);
    } else if (isAnswered) {
      answered.push(msg.id);
    } else {
      unanswered.push(msg.id);
    }
  }

  // One answer carries every message the turn answered, so atc records the
  // whole group at once and no member reads as answered before the rest.
  if (answered.length > 0) {
    scheduleAnsweredReport($, state, answered, turnID, answer);
  }

  if (unanswered.length > 0) {
    scheduleUnansweredReport($, state, unanswered, toUnansweredReason(reason), turnID);
  }
}

function toUnansweredReason(reason: string): string {
  if (reason === 'aborted') {
    return 'interrupted';
  }

  return reason === 'refusal' ? 'refusal' : 'error';
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

function scheduleUnansweredReport(
  $: EngineInterface,
  state: BridgeState,
  messageIDs: readonly string[],
  reason: string,
  turnID: string | null,
): void {
  state.reporting = state.reporting
    .then(async () => {
      await $.process.run(
        [
          ...ATC_CLI,
          'unanswered',
          '--messages',
          messageIDs.join(','),
          ...(turnID === null ? [] : ['--turn', turnID]),
          '--reason',
          reason,
        ],
        { timeoutMs: 5000 },
      );
    })
    .catch((error: unknown) => {
      $.ui.log(`atc-bridge: reporting ${messageIDs.join(', ')} failed (${String(error)})`, {
        to: 'debug',
      });
    });
}
