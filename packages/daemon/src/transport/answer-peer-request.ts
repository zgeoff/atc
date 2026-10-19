import { DaemonError } from '@atc/protocol/wire';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { StandardRPCCodec, StandardRPCHandler } from '@orpc/server/standard';
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { buildPeerError } from './build-peer-error';
import { DAEMON_ROUTER } from './daemon-router';
import type { ProcedureContext } from './procedure-context';
import { toPeerMethod } from './to-peer-method';

const PEER_HANDLER = new StandardRPCHandler(DAEMON_ROUTER, {
  clientInterceptors: [
    async (options) => {
      try {
        return await options.next();
      } catch (error) {
        throw buildPeerError(error);
      }
    },
  ],
});

const PEER_CODEC = new StandardRPCCodec(new StandardRPCSerializer(new StandardRPCJsonSerializer()));

// Answers one request a peer client sends: with the refusal the connection
// gave it, or with what its procedure answers.
export async function answerPeerRequest(
  request: StandardRequest,
  admitted: ProcedureContext | DaemonError,
): Promise<StandardResponse> {
  if (admitted instanceof DaemonError) {
    return PEER_CODEC.encodeError(buildPeerError(admitted));
  }

  const handled = await PEER_HANDLER.handle(
    { ...request, body: () => Promise.resolve(request.body) },
    { context: admitted },
  );

  if (handled.response !== undefined) {
    return handled.response;
  }

  const method = toPeerMethod(request.url.pathname);

  return PEER_CODEC.encodeError(
    buildPeerError(new DaemonError('unknown_method', `unknown method '${method}'`)),
  );
}
