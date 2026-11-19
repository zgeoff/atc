import type { EngineInterface, Register, TurnStepResult } from 'claude-code';
import { ATC_CLI } from './atc-cli.ts';
import { ATC_CWD, type BridgeState } from './bridge-state.ts';
import type { TapMessage } from './parse-tap-line.ts';
import { scheduleUnansweredReport } from './report-turns.ts';
import { runTap } from './run-tap.ts';
import { updateTurnCompleted, updateTurnStarted } from './track-turns.ts';

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

export const register: Register = (on) => {
  const state: BridgeState = {
    sessionID: null,
    runningTurnID: null,
    stepHold: null,
    delivering: Promise.resolve(),
    reporting: Promise.resolve(),
    awaitingTurn: new Map(),
    carried: new Map(),
    unseen: new Set(),
    unseenNotices: new Map(),
    shownNotices: new Set(),
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

  on('turn.step', async function* updateStepState($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e);
    }

    if (e.turnId === state.runningTurnID) {
      for (const msg of state.carried.get(e.turnId) ?? []) {
        state.unseen.delete(msg.id);
      }

      state.unseenNotices.get(e.turnId)?.splice(0);
    }

    updateStepStarted(state);

    let isServerToolRunning = false;

    try {
      const stepped = yield* next(e);

      isServerToolRunning = isServerToolUnfinished(stepped);

      return stepped;
    } finally {
      // A paused response's server tool call goes on in the next step, so the
      // hold stays until that step ends.
      if (!isServerToolRunning) {
        updateStepEnded(state);
      }
    }
  });

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e);

    if (e.agentId === undefined) {
      updateStepEnded(state);
    }

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
        cwd: ATC_CWD,
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

    const failure = await tryRunAnswer($, msg.id, text);

    if (failure !== null) {
      // A turn that ended during the call no longer reports the message, so
      // the failed answer settles it instead of leaving it delivered.
      if (state.carried.get(turnID ?? '') === carried) {
        carried.push(msg);
      } else {
        scheduleUnansweredReport($, state, [msg.id], 'error', turnID);
      }

      return { deny: `atc did not take the answer: ${failure}` };
    }

    return { result: `Handed to atc as the answer to ${msg.id}.` };
  });
};

// A step that continues a paused response keeps the hold the paused step left.
function updateStepStarted(state: BridgeState): void {
  if (state.stepHold !== null) {
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();

  state.stepHold = { ended: promise, end: resolve };
}

function updateStepEnded(state: BridgeState): void {
  state.stepHold?.end();
  state.stepHold = null;
}

// The API pauses a long response before a server tool call's result, and the
// engine sends the response back to go on: the call has no end yet.
function isServerToolUnfinished(stepped: TurnStepResult): boolean {
  return (
    stepped.stopReason === 'pause_turn' ||
    (stepped.serverToolUses ?? []).some((use) => use.endedAt === undefined)
  );
}

function removeCarriedMessage(carried: TapMessage[], msg: TapMessage): void {
  carried.splice(carried.indexOf(msg), 1);
}

// Why atc did not take the answer, or null once it did. The reporter always
// exits 0, so its printed delivery result shows whether atc took the answer.
async function tryRunAnswer(
  $: EngineInterface,
  messageID: string,
  text: string,
): Promise<string | null> {
  try {
    const ran = await $.process.run([...ATC_CLI, 'answer', '--message', messageID], {
      cwd: ATC_CWD,
      stdin: text,
      timeoutMs: 5000,
    });

    if (ran.exitCode !== 0) {
      return `atc exited with ${String(ran.exitCode)}`;
    }

    return ran.stdout.trim() === 'delivered' ? null : 'the answer did not reach atc';
  } catch (error) {
    return String(error);
  }
}

function isNoteLabel(value: string): value is (typeof NOTE_LABELS)[number] {
  return NOTE_LABELS.some((label) => label === value);
}
