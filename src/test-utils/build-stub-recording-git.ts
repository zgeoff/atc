/**
 * The script of a stand-in `git` that records each run by appending the
 * line `ran` to the record file, then exits 0 without doing anything else,
 * so a test can tell whether the code under test ran git at all.
 */
export function buildStubRecordingGit(record: string): string {
  return `#!/bin/sh\necho ran >> '${record}'\n`;
}
