export function buildStubHeldGH(): string {
  return `#!/bin/sh
case "$1" in
  config) echo https ;;
  *)
    while [ -f "$HOME/gh-hold" ]; do touch "$HOME/gh-held"; sleep 0.05; done
    echo '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]' ;;
esac
`;
}
