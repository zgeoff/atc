import { parseArgs } from 'node:util';

export type ReadStdin = () => Promise<string>;

// Only a hook that passes `--pushed-refs` hands over stdin; a manual run leaves stdin a terminal,
// where a read waits for input.
export function readPushedRefsInput(
  args: readonly string[],
  readStdin: ReadStdin,
): Promise<string | null> {
  const parsed = parseArgs({
    args: [...args],
    options: { 'pushed-refs': { type: 'boolean' } },
    strict: true,
  });

  return parsed.values['pushed-refs'] === true ? readStdin() : Promise.resolve(null);
}
