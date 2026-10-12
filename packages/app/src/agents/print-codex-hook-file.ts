import { buildCodexHookFile } from './build-codex-hook-file';

/**
 * Print the Codex hook entries to stdout. The operator merges them into
 * `$CODEX_HOME/hooks.json` and trusts them once in the Codex TUI — Codex
 * parses untrusted hooks but never runs them. atc never writes the user's
 * own Codex config. Each entry runs atc through `atcArgv`. `write` takes
 * the printed text, stdout by default.
 */
export function printCodexHookFile(
  atcArgv: readonly string[],
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): void {
  write(buildCodexHookFile(atcArgv));
}
