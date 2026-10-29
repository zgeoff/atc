import type { HostFiles } from '../agent-adapter';
import type { ExecutionProvider } from '../execution-provider';
import { parseMatchingLines } from './parse-matching-lines';

// A host that is asleep or out of reach rejects the command; its file then counts as one the
// host cannot read.
export function buildHostFiles(
  runCommand: ExecutionProvider['runCommand'],
  host: string,
): HostFiles {
  return {
    readMatchingLines: async (path, pattern) => {
      const read = await runCommand({
        argv: ['grep', '-E', '--', pattern, path],
        cwd: '/',
        host,
      }).catch(() => null);

      return read === null ? null : parseMatchingLines(read.stdout, read.exitCode);
    },

    readDirectory: async (path) => {
      const read = await runCommand({ argv: ['ls', '-A', '--', path], cwd: '/', host }).catch(
        () => null,
      );

      if (read === null || read.exitCode !== 0) {
        return null;
      }

      return read.stdout.split('\n').filter((name) => name !== '');
    },
  };
}
