import type { OutputClient, TapClient } from '../daemon-context';
import { buildMessageRequests } from './build-message-requests';
import type { MessageRequests } from './build-message-requests';
import { buildReadRequests } from './build-read-requests';
import type { ReadRequests } from './build-read-requests';
import { buildSpawnRequests } from './build-spawn-requests';
import type { SpawnRequests } from './build-spawn-requests';
import { buildTerminalRequests } from './build-terminal-requests';
import type { TerminalRequests } from './build-terminal-requests';
import type { ConnectionIdentity, RequestDeps } from './request-deps';

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
    spawn: buildSpawnRequests(deps),
    terminal: buildTerminalRequests(deps),
    reads: buildReadRequests(),
    messages: buildMessageRequests(deps),
  };
}
