/**
 * The script of a stand-in `zoxide` that lists no directories, and waits
 * for the test first: while `$HOME/zoxide-hold` exists, it waits for the
 * file to go, touching `$HOME/zoxide-held` on each pass of the wait, so the
 * marker appears only once the stand-in is held.
 */
export function buildStubHeldZoxide(): string {
  return `#!/bin/sh
while [ -f "$HOME/zoxide-hold" ]; do touch "$HOME/zoxide-held"; sleep 0.05; done
`;
}
