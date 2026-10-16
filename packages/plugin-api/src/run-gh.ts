import type { HostServices } from './host-services';

export interface GHRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs gh with arguments through the host's command runner until it exits
 * or the signal aborts; the runner kills gh's whole process group on
 * abort, so a wrapper or extension leaves no process behind. gh reads its
 * own config and the host's environment for its token, and is kept from
 * prompting, colouring, or checking for updates. A gh that could not start
 * exits 127.
 */
export async function runGH(
  run: HostServices['runCommand'],
  bin: string,
  signal: Readonly<AbortSignal>,
  args: readonly string[],
): Promise<GHRun> {
  const ran = await run([bin, ...args], {
    env: {
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      NO_COLOR: '1',
      LC_ALL: 'C',
    },
    signal,
  });

  return { exitCode: ran.code, stdout: ran.stdout, stderr: ran.stderr, timedOut: ran.aborted };
}
