import type { OutputClient, TapClient } from '../daemon-context';
import { MessageRequests } from './message-requests';
import { ReadRequests } from './read-requests';
import type { ConnectionIdentity, RequestDeps } from './request-deps';
import { SpawnRequests } from './spawn-requests';
import { TerminalRequests } from './terminal-requests';

// The request handlers of one connection, with the connection as the
// client the fleet attaches and who it acts as.
export interface ConnectionRequests {
  readonly client: OutputClient & TapClient;
  readonly identity: ConnectionIdentity;
  readonly spawn: SpawnRequests;
  readonly terminal: TerminalRequests;
  readonly reads: ReadRequests;
  readonly messages: MessageRequests;
}

export function buildConnectionRequests(deps: RequestDeps): ConnectionRequests {
  return {
    client: deps.client,
    identity: deps.identity,
    spawn: new SpawnRequests(deps),
    terminal: new TerminalRequests(deps),
    reads: new ReadRequests(),
    messages: new MessageRequests(deps),
  };
}
