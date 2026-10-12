import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

/**
 * Creates the command-line tools a remote host runs for a session, as
 * scripts under the directory: `atc` runs the atc CLI from this source tree,
 * and `claude` is a stand-in agent that prints `UP:<pid>`, then reads one
 * command per line and prints `GOT:<line>` after each, reporting through
 * that atc:
 *
 * - `start <id>`: a SessionStart for agent session `<id>`, with a
 *   transcript at a path only the host holds;
 * - `notify <text>`: a Notification carrying the text;
 * - `nested <id>`: a SessionStart for agent session `<id>` from a Codex
 *   harness nested inside the session;
 * - `forge <session>`: a Notification as atc session `<session>` instead
 *   of its own;
 * - `tap <file>`: the session's tap, run in the background and printing
 *   into the file;
 * - `answer <message> <text>`: the message answered with the text;
 * - `note <text>`: a note labelled `progress`.
 *
 * Returns each tool's path.
 */
export function createStubGuestCLIs(dir: string) {
  const cliPath = join(import.meta.dir, '..', 'cli.ts');

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
