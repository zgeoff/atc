import type { SessionID } from '@atc/core';
import type { DaemonContext, OutputClient, TapClient } from '../daemon-context';

// Who one connection acts as, which its handshake settles and its requests
// read.
export interface ConnectionIdentity {
  // The principal the whole connection acts as, from its handshake; null
  // for the daemon's owner, whose reach has no limit.
  principal: string | null;

  // The atc session the client runs inside; null for the owner. The kernel's answer binds it
  // on the local socket, and a handshake gives it only for a process in no session. A session
  // never changes its own or an ancestor's record through it, and sends every message as it.
  callerSession: SessionID | null;

  // The session the kernel found the connecting process in, by the pid it
  // holds for the local socket's peer; null on TCP, for a process outside
  // every session, and on a platform the daemon cannot ask.
  readonly peerSession: SessionID | null;

  // The client name the handshake gives, such as an atc build or the name
  // of another program.
  helloClient: string;
}

// The principal one request acts as, which narrows what the connection may
// reach for that request alone, and the name it labels a message with.
export interface RequestPrincipal {
  readonly principal: string;
  readonly name: string | undefined;
}

// What a connection's request handlers share: the connection as the client
// the fleet attaches, the daemon's own unscoped context, and who the
// connection acts as.
export interface RequestDeps {
  readonly client: OutputClient & TapClient;
  readonly ctx: DaemonContext;
  readonly identity: ConnectionIdentity;
}
