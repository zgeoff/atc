export function buildStubHeldGH(): string {
  return `#!/bin/sh
case "$1" in
  config) echo https ;;
  *)
    while [ -f "$HOME/gh-hold" ]; do touch "$HOME/gh-held"; sleep 0.05; done
    echo '[{"full_name":"me/dots","description":"dotfiles","private":false,"html_url":"https://github.com/me/dots","ssh_url":"git@github.com:me/dots.git"}]' ;;
esac
`;
}
