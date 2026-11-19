import type { SessionID } from '@atcx/contract';
import type { DaemonContext, OutputClient, TapClient } from '../types';

export interface ConnectionIdentity {
  principal: string | null;

  callerSession: SessionID | null;

  readonly peerSession: SessionID | null;

  helloClient: string;
}

export interface RequestPrincipal {
  readonly principal: string;
  readonly name: string | undefined;
}

export interface RequestDeps {
  readonly client: OutputClient & TapClient;
  readonly ctx: DaemonContext;
  readonly identity: ConnectionIdentity;
}
