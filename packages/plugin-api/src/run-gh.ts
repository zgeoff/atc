import type { HostServices } from './host-services';

export interface GHRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

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
