export function buildStubHeldZoxide(): string {
  return `#!/bin/sh
while [ -f "$HOME/zoxide-hold" ]; do touch "$HOME/zoxide-held"; sleep 0.05; done
`;
}
