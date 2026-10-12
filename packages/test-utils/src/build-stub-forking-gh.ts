/**
 * The script of a stand-in `gh` that starts a child of its own and waits on
 * it, as a gh extension might. It writes its own process ID, which is also
 * the ID of the process group it leads when started detached, and its
 * child's ID to `pidsFile`, one per line, moving the file into place so it
 * appears whole. The child runs until it is killed.
 */
export function buildStubForkingGH(pidsFile: string): string {
  return `#!/bin/sh\nsh -c 'sleep 30' &\nprintf '%s\\n%s\\n' $$ $! > '${pidsFile}.tmp'\nmv '${pidsFile}.tmp' '${pidsFile}'\nwait\n`;
}
