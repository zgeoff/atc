import type { SpawnPlan } from '@atc/plugin-api';

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
const SCRATCH_SCRIPT = 'mkdir -p "$1" && chmod 700 "$1" && shift && exec "$@"';
