import type { MessageBridgeHost, UnsettledMessage } from '@atc/plugin-api';
import type { AppServerConnection } from './app-server-connection';
import { AppServerError } from './app-server-error';
import type { AppServerTurn } from './parse-app-server-turn';
import { planLeftThreadRecovery } from './plan-left-thread-recovery';
import type { LeftThreadRecovery } from './plan-left-thread-recovery';
import { readThreadTurns } from './read-thread-turns';
import type { UnconfirmedSends } from './unconfirmed-sends';

export interface LeftThreadsRead {
  readonly conn: AppServerConnection;
  readonly unsettled: readonly UnsettledMessage[];
  readonly unconfirmed: UnconfirmedSends;
  readonly host: MessageBridgeHost;

  // whether the message went unconfirmed to a thread other than the one the bridge serves
  readonly isLeft: (message: string) => boolean;
}

// The JSON-RPC error code a Codex App Server answers a history read with
// when the thread has no history it can read.
const INVALID_REQUEST_CODE = -32_600;

// A left thread with no readable history strands its messages, since it
// may have taken them; any other failure rejects, and recovery retries.
export async function readLeftThreads(read: LeftThreadsRead): Promise<LeftThreadRecovery[]> {
  const byThread = new Map<string, UnsettledMessage[]>();

  for (const message of read.unsettled) {
    const thread = read.unconfirmed.findThread(message.id);

    if (thread !== undefined && read.isLeft(message.id)) {
      byThread.set(thread, [...(byThread.get(thread) ?? []), message]);
    }
  }

  const left: LeftThreadRecovery[] = [];

  for (const [thread, messages] of byThread) {
    let turns: AppServerTurn[] | null;

    try {
      turns = await readThreadTurns(read.conn, thread, messages);
    } catch (error) {
      if (!(error instanceof AppServerError) || error.code !== INVALID_REQUEST_CODE) {
        throw error;
      }

      read.host.log(
        `codex app server: the history of left thread ${thread} did not read (${String(error)})`,
      );

      turns = null;
    }

    left.push(planLeftThreadRecovery(messages, turns));
  }

  return left;
}
