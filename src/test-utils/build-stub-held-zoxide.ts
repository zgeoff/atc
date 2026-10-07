/**
 * The script of a stand-in `zoxide` that lists no directories, and waits
 * for the test first: while `$HOME/zoxide-hold` exists, it touches
 * `$HOME/zoxide-held` and waits for the file to go.
 */
export function buildStubHeldZoxide(): string {
  return `#!/bin/sh
if [ -f "$HOME/zoxide-hold" ]; then
  touch "$HOME/zoxide-held"
  while [ -f "$HOME/zoxide-hold" ]; do sleep 0.05; done
fi
`;
}
