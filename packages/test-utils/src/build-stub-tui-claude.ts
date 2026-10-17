import { getSourceEntry } from './get-source-entry';

export function buildStubTUIClaude(): string {
  const report = `"${process.execPath}" "${getSourceEntry('atc')}" hook-report`;

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
# bash 3.2 read -t takes whole seconds; a fraction times out immediately
for _ in $(seq 1 300); do
  if read -t 1 -r line; then echo "GOT:$line"; fi
done
`;
}
