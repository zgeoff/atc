import { isRecord } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { ORPCError, ValidationError, call, getRouter, isProcedure } from '@orpc/server';
import { DAEMON_ROUTER } from './daemon-router';
import type { ProcedureContext } from './procedure-context';

// Runs the procedure a request method names. Params its schema refuses are
// bad_args with the first issue's message; an answer its schema refuses is
// internal.
export async function runDaemonProcedure(
  method: string,
  params: unknown,
  context: ProcedureContext,
): Promise<Readonly<Record<string, unknown>>> {
  const path = method.split('.');
  const procedure = getRouter(DAEMON_ROUTER, path);

  if (!isProcedure(procedure)) {
    throw new DaemonError('unknown_method', `unknown method '${method}'`);
  }

  const input = isRecord(params) ? params : {};

  try {
    const answer: unknown = await call(procedure, input, { context, path });

    return isRecord(answer) ? answer : {};
  } catch (error) {
    throw toDaemonError(error);
  }
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
