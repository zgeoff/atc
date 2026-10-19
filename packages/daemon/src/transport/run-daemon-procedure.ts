import { isRecord } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { ORPCError, ValidationError, call, getRouter, isProcedure } from '@orpc/server';
import { DAEMON_ROUTER } from './daemon-router';
import type { ProcedureContext } from './procedure-context';

// The parts of a procedure's context a line request gives: the line
// protocol answers its handshake itself and pushes events unasked.
type LineProcedureContext = Pick<ProcedureContext, 'ctx' | 'requests' | 'as'>;

// Runs the procedure a request method names. Params its schema refuses are
// bad_args with the first issue's message; an answer its schema refuses is
// internal.
export async function runDaemonProcedure(
  method: string,
  params: unknown,
  context: LineProcedureContext,
): Promise<Readonly<Record<string, unknown>>> {
  const path = method.split('.');
  const procedure = getRouter(DAEMON_ROUTER, path);

  if (!isProcedure(procedure)) {
    throw buildUnknownMethodError(method);
  }

  const input = isRecord(params) ? params : {};

  const lineContext: ProcedureContext = {
    ...context,
    sentParams: params,
    answerHello: () => Promise.reject(buildUnknownMethodError(method)),
    subscribeEvents: () => {
      throw buildUnknownMethodError(method);
    },
  };

  try {
    const answer: unknown = await call(procedure, input, { context: lineContext, path });

    return isRecord(answer) ? answer : {};
  } catch (error) {
    throw toDaemonError(error);
  }
}

function buildUnknownMethodError(method: string): DaemonError {
  return new DaemonError('unknown_method', `unknown method '${method}'`);
}

function toDaemonError(error: unknown): unknown {
  if (!(error instanceof ORPCError) || !(error.cause instanceof ValidationError)) {
    return error;
  }

  const issue = error.cause.issues[0]?.message ?? 'invalid params';

  return error.code === 'BAD_REQUEST'
    ? new DaemonError('bad_args', issue)
    : new DaemonError('internal', `${error.message}: ${issue}`);
}
