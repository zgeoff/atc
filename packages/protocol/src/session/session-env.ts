export interface SessionEnv {
  readonly sessionID?: string;
  readonly socket?: string;

  readonly bridge?: boolean;
  readonly outbox?: string;
  readonly sessionRecord?: string;

  readonly inheritedEnv?: Readonly<Record<string, string | undefined>>;
}
