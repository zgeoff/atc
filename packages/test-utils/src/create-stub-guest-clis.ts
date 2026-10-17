import { createStubBin } from './create-stub-bin';
import { getSourceEntry } from './get-source-entry';

export function createStubGuestCLIs(dir: string) {
  const cliPath = getSourceEntry('atc');

  const atc = createStubBin(
    dir,
    'atc',
    `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`,
  );

  const claude = createStubBin(
    dir,
    'claude',
    `#!/usr/bin/env bash
echo "UP:$$"
while read -r line; do
  case "$line" in
    start\\ *) printf '{"hook_event_name":"SessionStart","session_id":"%s","transcript_path":"/guest/only/transcript.jsonl"}' "\${line#start }" | "${atc}" hook-report --agent claude ;;
    notify\\ *) printf '{"hook_event_name":"Notification","message":"%s"}' "\${line#notify }" | "${atc}" hook-report --agent claude ;;
    stop) echo '{"hook_event_name":"Stop"}' | "${atc}" hook-report --agent claude ;;
    nested\\ *) printf '{"hook_event_name":"SessionStart","session_id":"%s","source":"startup"}' "\${line#nested }" | "${atc}" hook-report --agent codex ;;
    forge\\ *) echo '{"hook_event_name":"Notification","message":"forged"}' | ATC_SESSION_ID="\${line#forge }" "${atc}" hook-report --agent claude ;;
    tap\\ *) "${atc}" tap --session "$ATC_SESSION_ID" >> "\${line#tap }" 2>&1 & ;;
    answer\\ *) rest="\${line#answer }"; printf '%s' "\${rest#* }" | "${atc}" answer --messages "\${rest%% *}" ;;
    note\\ *) printf '%s' "\${line#note }" | "${atc}" note --label progress ;;
  esac
  echo "GOT:$line"
done
`,
  );

  return { atc, claude };
}
