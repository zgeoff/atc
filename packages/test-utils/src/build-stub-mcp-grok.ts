import { getSourceEntry } from './get-source-entry';

export function buildStubMCPGrok(): string {
  const cliPath = getSourceEntry('atc');

  return `#!/usr/bin/env bash
echo $$ >> "$HOME/stub-pids"
echo "FAKE_GROK_UP args: $@"
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | "${process.execPath}" "${cliPath}" hook-report
exec cat
`;
}
