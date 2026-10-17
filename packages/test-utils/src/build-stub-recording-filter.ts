export function buildStubRecordingFilter(record: string): string {
  return `#!/bin/sh\necho ran >> '${record}'\ncat\n`;
}
