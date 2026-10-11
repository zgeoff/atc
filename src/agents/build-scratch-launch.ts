import type { SpawnPlan } from './agent-adapter';

/**
 * The launch of a CLI on a remote host that first creates the session's
 * scratch folder `scratch`, readable by its owner alone, and then runs
 * `argv`, the CLI's own command line, with the folder as its temporary
 * folder.
 */
export function buildScratchLaunch(
  scratch: string,
  argv: readonly string[],
): SpawnPlan & { readonly env: { readonly TMPDIR: string } } {
  return {
    bin: 'sh',
    args: ['-c', SCRATCH_SCRIPT, 'sh', scratch, ...argv],
    env: { TMPDIR: scratch },
  };
}

// The arguments are the scratch folder and the CLI's own command line.
const SCRATCH_SCRIPT = 'mkdir -p -m 700 "$1" && shift && exec "$@"';
