export function resolveHeadlessExecutable(
  claudeBin: string,
  compiled: boolean,
): { readonly pathToClaudeCodeExecutable: string; readonly executable?: 'node' } | null {
  // A compiled binary cannot reach the SDK's bundled CLI, so use the claude on PATH.
  if (!compiled) {
    return null;
  }

  // Bun.which defaults to a PATH snapshot, but spawns inherit the live PATH.
  const path = claudeBin.includes('/')
    ? claudeBin
    : (Bun.which(claudeBin, { PATH: process.env['PATH'] ?? '' }) ?? claudeBin);

  // An npm-installed claude is a js file, and the SDK would run it under bun, which is absent.
  return /\.[cm]?js$/u.test(path)
    ? { pathToClaudeCodeExecutable: path, executable: 'node' }
    : { pathToClaudeCodeExecutable: path };
}
