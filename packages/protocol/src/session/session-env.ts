export interface SessionEnv {
  readonly sessionID?: string;
  readonly socket?: string;

  // whether the socket is the session bridge, which takes bridge requests
  // rather than reporter lines
  readonly bridge?: boolean;
  readonly outbox?: string;
  readonly sessionRecord?: string;

  // the environment the session's variables go over, whose OpenTelemetry
  // resource attributes the session's own attribute joins
  readonly inheritedEnv?: Readonly<Record<string, string | undefined>>;
}
