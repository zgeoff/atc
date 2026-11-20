import { AtcError } from '@atcx/contract/light';
import type { CommandError } from './types';

export type FailureStage = 'list' | 'send' | 'recover' | 'wait';

interface FailureContext {
  readonly stage: FailureStage;

  readonly closed: boolean;

  readonly remote: boolean;
}

export type PickedFailure =
  | { readonly kind: 'ended'; readonly exitCode: number; readonly error: CommandError }
  | { readonly kind: 'recover'; readonly effectRef: string };

export function pickSendFailure(error: unknown, context: Readonly<FailureContext>): PickedFailure {
  const failure = error instanceof AtcError ? error : new AtcError('internal', String(error));
  const effectRef = failure.data?.['effectRef'];

  if (
    context.stage === 'send' &&
    (failure.code === 'outcome_unknown' ||
      failure.code === 'internal' ||
      failure.code === 'connection_lost') &&
    typeof effectRef === 'string'
  ) {
    return { kind: 'recover', effectRef };
  }

  if ((failure.code === 'internal' || failure.code === 'connection_lost') && context.closed) {
    return ended(4, 'unreachable', failure.message);
  }

  if (context.stage === 'recover') {
    const absent = failure.code === 'bad_args' && !context.remote;
    const exitCode = absent ? 5 : 6;

    return ended(
      exitCode,
      'outcome_unknown',
      `the daemon did not say whether the message was delivered: ${failure.message}`,
    );
  }

  if (context.stage === 'send') {
    if (failure.code === 'no_such_session') {
      return ended(3, 'no_such_session', failure.message);
    }

    if (failure.code === 'outcome_unknown') {
      const exitCode = context.remote ? 6 : 5;

      return ended(exitCode, 'outcome_unknown', failure.message);
    }

    if (failure.code === 'idempotency_conflict') {
      return ended(6, 'idempotency_conflict', failure.message);
    }
  }

  return ended(1, failure.code, failure.message);
}

function ended(exitCode: number, code: string, message: string): PickedFailure {
  return { kind: 'ended', exitCode, error: { code, message } };
}
