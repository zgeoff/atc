import type { CommandOutcome } from './send-types';

interface FormatOptions {
  readonly command: 'send' | 'message get';
  readonly json: boolean;
}

// What a command writes: stdout, when it writes any, and stderr.
interface CommandOutput {
  readonly stdout: string | null;
  readonly stderr: string | null;
}

export function formatCommandOutcome(
  outcome: Readonly<CommandOutcome>,
  options: Readonly<FormatOptions>,
): CommandOutput {
  if (options.json) {
    return { stdout: formatJSON(outcome, options.command), stderr: null };
  }

  return {
    stdout: formatPlain(outcome, options.command),
    stderr: formatFailureLine(outcome, options.command),
  };
}

// The exits that carry a message: answered or sent, unanswered, and waited
// out.
const MESSAGE_EXITS: ReadonlySet<number> = new Set([0, 7, 8]);

function formatJSON(outcome: Readonly<CommandOutcome>, command: FormatOptions['command']): string {
  const progress = outcome.progress;
  const carriesMessage = MESSAGE_EXITS.has(outcome.exitCode);

  if (command === 'message get') {
    const view = carriesMessage && outcome.view !== null ? outcome.view : { error: outcome.error };

    return JSON.stringify(view);
  }

  if (
    carriesMessage &&
    progress !== null &&
    outcome.key !== null &&
    outcome.session !== null &&
    outcome.message !== null
  ) {
    return JSON.stringify({
      key: outcome.key,
      session: outcome.session,
      message: outcome.message,
      status: progress.status,
      ...(progress.answer === undefined ? {} : { answer: progress.answer }),
      ...(progress.unansweredReason === undefined
        ? {}
        : { unansweredReason: progress.unansweredReason }),
    });
  }

  return JSON.stringify({
    ...(outcome.key === null ? {} : { key: outcome.key }),
    ...(outcome.message === null ? {} : { message: outcome.message }),
    error: outcome.error,
  });
}

function formatPlain(
  outcome: Readonly<CommandOutcome>,
  command: FormatOptions['command'],
): string | null {
  const progress = outcome.progress;

  if (!MESSAGE_EXITS.has(outcome.exitCode) || progress === null) {
    return null;
  }

  if (command === 'message get') {
    return progress.answer === undefined
      ? progress.status
      : `${progress.status}\n${progress.answer}`;
  }

  if (outcome.exitCode === 7) {
    return null;
  }

  return progress.answer ?? outcome.message;
}

function formatFailureLine(
  outcome: Readonly<CommandOutcome>,
  command: FormatOptions['command'],
): string | null {
  const error = outcome.error;

  if (error === null) {
    return null;
  }

  const known = [
    ...(outcome.key === null ? [] : [`key ${outcome.key}`]),
    ...(outcome.message === null ? [] : [`message ${outcome.message}`]),
  ];

  const hint =
    error.code === 'session_dead' && outcome.session !== null
      ? `; start it with: atc session adopt ${outcome.session}`
      : '';

  const [first = '', ...rest] = `${error.message}${hint}`.split('\n');
  const suffix = known.length === 0 ? '' : ` (${known.join(', ')})`;

  return [`atc ${command}: ${error.code}: ${first}${suffix}`, ...rest].join('\n');
}
