import type { DaemonAnswer } from '@atc/protocol';
import { MAX_CHUNK, MAX_LINE } from '@atc/protocol/wire';
import { DAEMON_FEATURES } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import type { DaemonContext } from '../types';

export async function loadHelloAnswer(
  ctx: DaemonContext,
  peerSession: SessionID | null,
): Promise<DaemonAnswer<'daemon.hello'>> {
  return {
    daemon: ctx.build,
    daemonID: ctx.daemonID,
    limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
    idempotency: { completedRetentionMs: ctx.idempotencyRetentionMs },
    lastUsedAgent: await ctx.loadLastUsedAgent(),
    peerSession,
    features: DAEMON_FEATURES,
  };
}
