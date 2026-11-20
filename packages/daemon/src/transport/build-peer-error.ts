import { AtcError } from '@atcx/contract/light';
import { ORPCError, ValidationError } from '@orpc/server';

export function buildPeerError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof AtcError) {
    return new ORPCError(error.code, { message: error.message, data: error.data, cause: error });
  }

  if (error instanceof ORPCError && error.cause instanceof ValidationError) {
    const issue = error.cause.issues[0]?.message ?? 'invalid params';
    const code = error.code === 'BAD_REQUEST' ? 'bad_args' : 'internal';
    const message = code === 'bad_args' ? issue : `${error.message}: ${issue}`;

    return new ORPCError(code, { message, cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);

  return new ORPCError('internal', { message, cause: error });
}
