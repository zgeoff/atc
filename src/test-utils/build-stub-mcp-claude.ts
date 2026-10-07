import { join } from 'node:path';

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts');

/**
 * The script of a stand-in `claude` for the stdio MCP suites. It prints
 * `FAKE_CLAUDE_UP args: ` and its arguments, then stays up. Unless the file
 * `$HOME/fake-claude-hold-start` exists, it first reports `SessionStart`
 * through the real reporter with session id `fake-1` and transcript
 * `$HOME/fake-transcript.jsonl`, and when `$HOME/fake-claude-note` exists it
 * files that file's text as a report labelled `decision`.
 */
export function buildStubMCPClaude(): string {
  const cli = `"${process.execPath}" "${CLI_PATH}"`;

  return `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
if [ -f "$HOME/fake-claude-hold-start" ]; then exec sleep 30; fi
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | ${cli} hook-report
if [ -f "$HOME/fake-claude-note" ]; then ${cli} report note --label decision < "$HOME/fake-claude-note"; fi
exec sleep 30
`;
}
