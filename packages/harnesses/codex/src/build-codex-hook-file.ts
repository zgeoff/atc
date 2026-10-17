import { buildHookCommand, buildHookEntry } from '@atc/plugin-api';
import { CODEX_HOOKS } from './codex-hooks';

export function buildCodexHookFile(argv: readonly string[]): string {
  const cmd = buildHookCommand('hook-report --agent codex', argv);

  const hooks = Object.fromEntries(
    Object.keys(CODEX_HOOKS).map((event) => {
      // Codex caps SessionEnd hooks at three seconds.
      const timeout = event === 'SessionEnd' ? 3 : 5;

      return [event, [buildHookEntry(cmd, timeout)]];
    }),
  );

  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}
