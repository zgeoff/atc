import { buildCodexHookFile } from './build-codex-hook-file';

/**
 * Print the Codex hook entries to stdout. The operator merges them into
 * `$CODEX_HOME/hooks.json` and trusts them once in the Codex TUI — Codex
 * parses untrusted hooks but never runs them. atc never writes the user's
 * own Codex config.
 */
export function printCodexHookFile(): void {
  process.stdout.write(buildCodexHookFile());
}
