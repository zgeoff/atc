export function resolveHeadlessExecutable(
  claudeBin: string,
  compiled: boolean,
): { readonly pathToClaudeCodeExecutable: string; readonly executable?: 'node' } | null {
  // a compiled atc cannot reach the SDK's bundled CLI, so it hands over the `claude` on PATH
  if (!compiled) {
    return null;
  }

  // Spawns inherit this process's PATH, so the search list is read live
  // rather than left to the snapshot Bun.which defaults to.
  const path = claudeBin.includes('/')
    ? claudeBin
    : (Bun.which(claudeBin, { PATH: process.env['PATH'] ?? '' }) ?? claudeBin);

  // an npm-installed `claude` is a js entry the SDK would otherwise run under an absent bun
  return /\.[cm]?js$/u.test(path)
    ? { pathToClaudeCodeExecutable: path, executable: 'node' }
    : { pathToClaudeCodeExecutable: path };
}
