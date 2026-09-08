/**
 * The Claude Code executable a headless turn runs under. The Agent SDK
 * carries its own copy of the CLI as a platform package, which a compiled
 * atc binary cannot reach, so a compiled binary hands the SDK the same
 * `claude` the terminal sessions spawn, resolved on PATH. An npm-installed
 * `claude` is a JavaScript entry and runs under node, since the SDK would
 * otherwise spawn it under a bun that is not installed. Under a source run
 * the SDK's own copy stays in use and the result is empty.
 */
export function resolveHeadlessExecutable(
  claudeBin: string,
  compiled: boolean,
): { readonly pathToClaudeCodeExecutable: string; readonly executable?: 'node' } | null {
  if (!compiled) {
    return null;
  }

  // Spawns inherit this process's PATH, so the search list is read live
  // rather than left to the snapshot Bun.which defaults to.
  const path = claudeBin.includes('/')
    ? claudeBin
    : (Bun.which(claudeBin, { PATH: process.env['PATH'] ?? '' }) ?? claudeBin);

  return /\.[cm]?js$/u.test(path)
    ? { pathToClaudeCodeExecutable: path, executable: 'node' }
    : { pathToClaudeCodeExecutable: path };
}
