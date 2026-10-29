import { parseMatchingLines } from '@atc/plugin-api';
import type { ExecutionProvider, HostFiles } from '@atc/plugin-api';

// A host that is asleep or out of reach rejects the command; its file then
// counts as one the host cannot read.
export function makeGuestMatchingLinesReader(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  host: string,
): HostFiles['readMatchingLines'] {
  return async (path, pattern) => {
    const read = await provider
      .runCommand({ argv: ['grep', '-E', '--', pattern, path], cwd: '/', host })
      .catch(() => null);

    return read === null ? null : parseMatchingLines(read.stdout, read.exitCode);
  };
}
