/**
 * What a session's environment tells a process running inside it. A field
 * is absent when its variable is unset or empty.
 */
export interface SessionEnv {
  readonly sessionID?: string;
  readonly socket?: string;

  // whether the socket is the session bridge, which takes bridge requests
  // rather than reporter lines
  readonly bridge?: boolean;
  readonly outbox?: string;
  readonly sessionRecord?: string;
}
