import { join } from 'node:path';

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts');

/**
 * The script of a stand-in `grok` for the stdio MCP suites. It appends its
 * pid to `$HOME/stub-pids`, prints `FAKE_GROK_UP args: ` and its arguments,
 * reports `session_start` through the real reporter with session id
 * `fake-grok-1` and its working directory, then echoes its input back until
 * that input closes.
 */
export function buildStubMCPGrok(): string {
  return `#!/usr/bin/env bash
echo $$ >> "$HOME/stub-pids"
echo "FAKE_GROK_UP args: $@"
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | "${process.execPath}" "${CLI_PATH}" hook-report
exec cat
`;
}
