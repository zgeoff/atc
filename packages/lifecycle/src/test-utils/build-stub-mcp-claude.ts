export function buildStubMCPClaude(cliEntry: string): string {
  const cli = `"${process.execPath}" "${cliEntry}"`;

  return `#!/usr/bin/env bash
echo $$ >> "$HOME/stub-pids"
echo "FAKE_CLAUDE_UP args: $@"
if [ -f "$HOME/fake-claude-hold-start" ]; then exec cat; fi
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | ${cli} hook-report
if [ -f "$HOME/fake-claude-note" ]; then ${cli} note --label decision < "$HOME/fake-claude-note"; fi
exec cat
`;
}
