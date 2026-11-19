import { buildCodexHookFile } from './build-codex-hook-file';

// codex never runs a hook the user has not trusted in the TUI, so the hook file is
// printed for the operator to merge into `$CODEX_HOME/hooks.json`.
export function printCodexHookFile(
  atcArgv: readonly string[],
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): void {
  write(buildCodexHookFile(atcArgv));
}
