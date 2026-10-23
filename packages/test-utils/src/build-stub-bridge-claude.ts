// Claude Code loads the atc-bridge mod at start and after each write of its files, and each
// load starts `atc tap` and ends the last one. The script removes the file it loads, since
// mtimes in one second compare equal and a newer-file check would miss a write.
export function buildStubBridgeClaude(atcArgv: readonly string[], guestDirectory: string): string {
  const atc = atcArgv.map((part) => formatShellWord(part)).join(' ');
  const guest = formatShellWord(guestDirectory);

  return `#!/usr/bin/env bash
MOD=${guest}/sessions/"$ATC_SESSION_ID"/atc-bridge/hooks/atc-cli.ts
TAP=""
load_mod() {
  if [ -n "$TAP" ]; then kill "$TAP" 2>/dev/null; fi
  ${atc} tap --session "$ATC_SESSION_ID" --notices &
  TAP=$!
}
printf '{"hook_event_name":"SessionStart","session_id":"stub-1"}' | ${atc} hook-report
load_mod
while sleep 0.05; do
  if [ -f "$MOD" ]; then
    rm -f "$MOD"
    load_mod
  fi
done
`;
}

function formatShellWord(text: string): string {
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}
