export interface ATCInvocation {
  readonly argv: readonly string[];

  // read on every call, so a long-lived process that a rebuild overtakes
  // sends the new stamp.
  readonly readBuild: () => string;
}
