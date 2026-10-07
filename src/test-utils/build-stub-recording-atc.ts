/**
 * The script of a stand-in `atc` that records each run: it appends
 * `args:<arguments>`, `session:<$ATC_SESSION_ID>`, and `stdin:<what it
 * read>` to the log, each on its own line, and exits 0.
 */
export function buildStubRecordingATC(log: string): string {
  return `#!/bin/sh
{ printf 'args:%s\\n' "$*"; printf 'session:%s\\n' "$ATC_SESSION_ID"; printf 'stdin:'; cat; printf '\\n'; } >> '${log}'
`;
}
