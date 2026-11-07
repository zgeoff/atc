import { toShellArg } from '@atc/core';

const SOURCE_THEN_RUN_SCRIPT = '. "$1" && shift && exec "$@"';

// `sh` sources the env file, since the user's own shell may be one, such as
// fish, that takes no POSIX subshell.
export function formatResumeCommand(cwd: string, command: string, envFile: string | null): string {
  const run =
    envFile === null
      ? command
      : `sh -c ${toShellArg(SOURCE_THEN_RUN_SCRIPT)} sh ${toShellArg(envFile)} ${command}`;

  return `cd ${toShellArg(cwd)} && ${run}`;
}
