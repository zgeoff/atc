import { toShellArg } from '@atc/core';

// The script `sh` runs for a resume with an env file: it sources the file,
// then runs the command words that follow it.
const SOURCE_THEN_RUN_SCRIPT = '. "$1" && shift && exec "$@"';

// The command that re-opens a session in its folder. With an env file, `sh`
// sources it and runs the command, since the user's own shell may be one,
// such as fish, that takes no POSIX subshell.
export function formatResumeCommand(cwd: string, command: string, envFile: string | null): string {
  const run =
    envFile === null
      ? command
      : `sh -c ${toShellArg(SOURCE_THEN_RUN_SCRIPT)} sh ${toShellArg(envFile)} ${command}`;

  return `cd ${toShellArg(cwd)} && ${run}`;
}
