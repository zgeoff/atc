import { toShellArg } from '@atc/core';

// The command that re-opens a session in its folder. With an env file, a
// subshell sources it, so the entry's env reaches the agent and leaves the
// caller's own shell as it was.
export function formatResumeCommand(cwd: string, command: string, envFile: string | null): string {
  const run = envFile === null ? command : `( . ${toShellArg(envFile)} && exec ${command} )`;

  return `cd ${toShellArg(cwd)} && ${run}`;
}
