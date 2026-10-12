/**
 * Where a Claude-family adapter writes its generated settings files and
 * where it finds the user's home, whose Claude config it reads. A field
 * left out takes atc's state folder or the running user's home.
 */
export interface ClaudeHostPaths {
  readonly stateDir?: string;
  readonly homeDir?: string;
}
