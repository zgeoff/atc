import { join } from 'node:path';

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts');

/**
 * The script of a stand-in `grok` for the TUI suites. It prints
 * `FAKE_GROK_UP args: ` and its arguments at start and again on every
 * SIGWINCH, reports `session_start` through the real reporter with session
 * id `fake-grok-1` and its working directory, then a `permission_prompt`
 * notification, prints `FAKE_GROK_HOOKS_DONE`, and echoes each line it
 * reads as `GOT:<line>` for five minutes. Scenario files in `$HOME` change
 * it: `fake-grok-events.jsonl` replaces the notification with its hook
 * lines, `fake-grok-hold-start` skips every report, and while
 * `fake-grok-defer-start` exists it touches `fake-grok-start-deferred` and
 * waits before it reports.
 */
export function buildStubTUIGrok(): string {
  const report = `"${process.execPath}" "${CLI_PATH}" hook-report`;

  return `#!/usr/bin/env bash
ARGS="$*"
paint() { echo "FAKE_GROK_UP args: $ARGS"; }
trap paint WINCH
paint
idle() {
  for _ in $(seq 1 300); do
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
