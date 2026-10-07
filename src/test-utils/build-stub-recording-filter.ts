/**
 * The script of a stand-in git filter driver that records each run by
 * appending the line `ran` to the record file and passes its input through
 * unchanged, as a smudge filter that changes nothing does, so a test can
 * tell whether git ran a filter the host configured.
 */
export function buildStubRecordingFilter(record: string): string {
  return `#!/bin/sh\necho ran >> '${record}'\ncat\n`;
}
