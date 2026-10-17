export function buildStubRecordingGit(record: string): string {
  return `#!/bin/sh\necho ran >> '${record}'\n`;
}
