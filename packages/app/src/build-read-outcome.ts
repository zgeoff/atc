import type { CommandError, CommandOutcome, MessageView } from './send-types';

// What the command knew before it read the message.
export interface OutcomeBase {
  readonly key: string | null;
  readonly session: string | null;
  readonly message: string | null;
}

export function buildFailureOutcome(
  base: Readonly<OutcomeBase>,
  exitCode: number,
  error: Readonly<CommandError>,
): CommandOutcome {
  return { ...base, exitCode, progress: null, view: null, error };
}

export function buildReadOutcome(
  base: Readonly<OutcomeBase>,
  view: Readonly<MessageView>,
  timedOut: boolean,
): CommandOutcome {
  const progress = {
    status: view.status,
    ...(view.answer === undefined ? {} : { answer: view.answer }),
    ...(view.unansweredReason === undefined ? {} : { unansweredReason: view.unansweredReason }),
  };

  if (view.status === 'unanswered') {
    return {
      ...base,
      exitCode: 7,
      progress,
      view,
      error: {
        code: 'unanswered',
        message: view.unansweredReason ?? 'the message ended without an answer',
      },
    };
  }

  if (timedOut) {
    return {
      ...base,
      exitCode: 8,
      progress,
      view,
      error: {
        code: 'wait_timeout',
        message: `the message is still ${view.status}; resume with: atc message get ${view.message} --wait`,
      },
    };
  }

  return { ...base, exitCode: 0, progress, view, error: null };
}
