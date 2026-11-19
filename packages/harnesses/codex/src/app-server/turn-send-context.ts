import type { MessageBridgeHost } from '@atc/plugin-api';
import type { AppServerConnection } from './create-app-server-connection';
import type { UnconfirmedSends } from './create-unconfirmed-sends';

export interface TurnSendContext {
  readonly host: MessageBridgeHost;
  readonly model: string | undefined;

  readonly unconfirmed: UnconfirmedSends;

  readonly waitOutOverload: (conn: AppServerConnection) => Promise<boolean>;

  readonly dropConnection: (conn: AppServerConnection) => void;

  readonly resetOverload: () => void;

  readonly carryMessage: (message: string, turn: string) => void;
}
