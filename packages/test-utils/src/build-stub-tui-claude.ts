export function buildStubTUIClaude(cliEntry: string): string {
  const report = `"${process.execPath}" "${cliEntry}" hook-report`;

  return `#!/usr/bin/env bash
ARGS="$*"
case "$ARGS" in *--resume*)
  if [ -f "$HOME/fake-claude-hold-resume" ]; then
    touch "$HOME/fake-claude-resume-held"
    while [ -f "$HOME/fake-claude-hold-resume" ]; do sleep 0.05; done
  fi ;;
esac
paint() { echo "FAKE_CLAUDE_UP args: $ARGS"; }
trap paint WINCH
paint
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | ${report}
if [ -f "$HOME/fake-claude-events.jsonl" ]; then
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    sleep 0.3
    printf '%s' "$ev" | ${report}
  done < "$HOME/fake-claude-events.jsonl"
else
  sleep 0.3
  printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | ${report}
fi
# bash 3.2 read -t takes whole seconds; a fraction times out immediately.
# A command substitution here lets a WINCH trap that lands during it fail to parse
for ((tick = 0; tick < 300; tick++)); do
  if read -t 1 -r line; then echo "GOT:$line"; fi
done
`;
}
