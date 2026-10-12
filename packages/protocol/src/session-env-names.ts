/**
 * The environment variables atc sets for a session's harness: the session's
 * id, the socket its reporters write to, whether that socket is the
 * session bridge, the bridge's outbox, and the path of the session's
 * record. Reporters, the mcp server and restart read them back.
 */
export const SESSION_ENV_NAMES = {
  sessionID: 'ATC_SESSION_ID',
  socket: 'ATC_SOCKET',
  bridge: 'ATC_BRIDGE',
  outbox: 'ATC_OUTBOX',
  sessionRecord: 'ATC_SESSION_RECORD',
} as const;
