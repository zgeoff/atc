import type { MessageBridgeHost } from '@atc/plugin-api';
import type { AppServerConnection } from './app-server-connection';
import type { UnconfirmedSends } from './unconfirmed-sends';

// What a send that starts a turn needs from the bridge that queues it.
export interface TurnSendContext {
  readonly host: MessageBridgeHost;
  readonly model: string | undefined;

  // the thread each message went to when its connection dropped before the answer to its send
  readonly unconfirmed: UnconfirmedSends;

  // true means send again on the same connection
  readonly waitOutOverload: (conn: AppServerConnection) => Promise<boolean>;

  // closes the connection when it is still the bridge's own, and schedules a reconnect
  readonly dropConnection: (conn: AppServerConnection) => void;

  // starts the wait between overloaded sends again from its first length
  readonly resetOverload: () => void;

  // tracks the turn that carries the message, unless that turn has settled
  readonly carryMessage: (message: string, turn: string) => void;
}
