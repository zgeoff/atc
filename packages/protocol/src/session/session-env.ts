export interface SessionEnv {
  readonly sessionID?: string;
  readonly socket?: string;

  // whether the socket is the session bridge, which takes bridge requests
  // rather than reporter lines
  readonly bridge?: boolean;
  readonly outbox?: string;
  readonly sessionRecord?: string;
}
