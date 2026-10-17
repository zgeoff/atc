import { buildCodexHookFile } from './build-codex-hook-file';

// the operator merges these into `$CODEX_HOME/hooks.json` and trusts them once in the TUI, since
// codex never runs an untrusted hook; atc never writes the user's own codex config
export function printCodexHookFile(
  atcArgv: readonly string[],
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): void {
  write(buildCodexHookFile(atcArgv));
}
