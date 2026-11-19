import type { SessionEnv } from '@atc/protocol/session';

// A session on a remote host reaches the daemon only through its bridge socket,
// which acts with the session's atc access.
export function findBridgeSocket(sessionEnv: SessionEnv): string | null {
  return sessionEnv.bridge === true ? (sessionEnv.socket ?? null) : null;
}
