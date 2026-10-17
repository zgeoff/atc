import { createStubBin } from './create-stub-bin';

interface StubClaudeConfig {
  // The command atc runs as, which the stub's tap and restart go through.
  readonly atc: readonly string[];

  // The composer script the stub finishes in when the home asks for it.
  readonly composer: string;
}

// Like the real CLI, the stand-in runs the SessionStart hook command from the
// --settings file through a shell, so a session reports with the command line
// atc wrote for its agent.
export function createStubClaude(dir: string, config: StubClaudeConfig): string {
  const atc = config.atc.map((part) => `"${part}"`).join(' ');

  return createStubBin(
    dir,
    'fake-claude',
    `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
echo "FAKE_CLAUDE_TERM:[\${TERM-unset}]"
echo "FAKE_CLAUDE_PARENT:[\${CLAUDE_CODE_ATC_TEST-unset}]"
echo "$ATC_SESSION_ID" >> "$HOME/fake-claude-starts.log"
settings=""
resume=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--settings" ]; then settings="$arg"; fi
  if [ "$prev" = "--resume" ]; then resume="$arg"; fi
  prev="$arg"
done
if [ -n "$resume" ] && [ -f "$HOME/fake-claude-dies-$resume" ]; then exit 0; fi
if [ -f "$HOME/fake-claude-hold-start" ]; then while read -r line; do echo "GOT:$line"; done; exit 0; fi
if [ -f "$HOME/fake-claude-composer" ]; then exec "${process.execPath}" "${config.composer}"; fi
hookCommand="$("${process.execPath}" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv.at(-1), "utf8")); console.log(s.hooks.SessionStart[0].hooks[0].command)' "$settings" < /dev/null)"
hookReport() { sh -c "$hookCommand"; }
sessionID="fake-1"
if [ -f "$HOME/fake-claude-own-id" ]; then sessionID="$ATC_SESSION_ID"; fi
if [ -f "$HOME/fake-claude-gate" ]; then rm "$HOME/fake-claude-gate"; read -r _; fi
printf '{"hook_event_name":"SessionStart","session_id":"%s","transcript_path":"%s/fake-transcript.jsonl"}' "$sessionID" "$HOME" | hookReport
if [ -f "$HOME/fake-claude-restart" ]; then rm "$HOME/fake-claude-restart"; ${atc} daemon restart > "$HOME/restart.out" 2>&1; fi
if [ -f "$HOME/fake-claude-tap" ]; then ${atc} tap --session "$ATC_SESSION_ID" >> "$HOME/tap.jsonl" & fi
printf '{"hook_event_name":"Notification","session_id":"%s","message":"needs permission"}' "$sessionID" | hookReport
if [ -f "$HOME/fake-claude-events.jsonl" ]; then
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | hookReport
  done < "$HOME/fake-claude-events.jsonl"
fi
if [ -f "$HOME/fake-claude-exit" ]; then exit 0; fi
if [ -f "$HOME/fake-claude-composer-last" ]; then exec "${process.execPath}" "${config.composer}"; fi
while read -r line; do echo "GOT:$line"; done
`,
  );
}
