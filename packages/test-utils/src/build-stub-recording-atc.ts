export function buildStubRecordingATC(log: string): string {
  return `#!/bin/sh
{ printf 'args:%s\\n' "$*"; printf 'session:%s\\n' "$ATC_SESSION_ID"; printf 'stdin:'; cat; printf '\\n'; } >> '${log}'
`;
}
