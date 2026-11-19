export function buildStubForkingGH(pidsFile: string): string {
  return `#!/bin/sh\nsh -c 'sleep 30' &\nprintf '%s\\n%s\\n' $$ $! > '${pidsFile}.tmp'\nmv '${pidsFile}.tmp' '${pidsFile}'\nwait\n`;
}
