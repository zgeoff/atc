export function buildStubTUIGrok(cliEntry: string): string {
  const report = `"${process.execPath}" "${cliEntry}" hook-report`;

  return `#!/usr/bin/env bash
ARGS="$*"
paint() { echo "FAKE_GROK_UP args: $ARGS"; }
trap paint WINCH
paint
idle() {
  # a command substitution here lets a WINCH trap that lands during it fail to parse
  for ((tick = 0; tick < 300; tick++)); do
    if read -t 1 -r line; then echo "GOT:$line"; fi
  done
}
if [ -f "$HOME/fake-grok-hold-start" ]; then
  idle
  exit 0
fi
if [ -f "$HOME/fake-grok-defer-start" ]; then
  touch "$HOME/fake-grok-start-deferred"
  while [ -f "$HOME/fake-grok-defer-start" ]; do sleep 0.05; done
fi
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | ${report}
if [ -f "$HOME/fake-grok-events.jsonl" ]; then
  sleep 0.3
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | ${report}
    sleep 0.2
  done < "$HOME/fake-grok-events.jsonl"
else
  sleep 0.3
  printf '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}' | ${report}
fi
echo "FAKE_GROK_HOOKS_DONE"
idle
`;
}
