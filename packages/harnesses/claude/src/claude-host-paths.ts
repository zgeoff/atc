// a field left out takes atc's state folder or the running user's home
export interface ClaudeHostPaths {
  readonly stateDir?: string;
  readonly homeDir?: string;
}
