/**
 * How this build of atc runs itself, which only the app's entry can tell:
 * `argv` starts the CLI, the compiled binary alone or bun with the CLI
 * entrypoint, and `readBuild` reads the build stamp a client sends in its
 * hello. The stamp is read on every call, so a long-lived process that a
 * rebuild overtakes sends the new stamp.
 */
export interface ATCInvocation {
  readonly argv: readonly string[];
  readonly readBuild: () => string;
}
