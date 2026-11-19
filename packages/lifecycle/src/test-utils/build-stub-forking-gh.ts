// $$ is also the id of the process group the script leads when started
// detached, and the rename makes the pids file appear whole.
export function buildStubForkingGH(pidsFile: string): string {
  return `#!/bin/sh\nsh -c 'sleep 30' &\nprintf '%s\\n%s\\n' $$ $! > '${pidsFile}.tmp'\nmv '${pidsFile}.tmp' '${pidsFile}'\nwait\n`;
}
