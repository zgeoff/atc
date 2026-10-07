/**
 * The script of a stand-in `gh` whose repository listing waits for the
 * test. `gh config …` prints `https`. Any other command touches
 * `$HOME/gh-held` and waits while `$HOME/gh-hold` exists, then prints one
 * repository, `me/dots`, in the JSON shape `gh repo list` prints.
 */
export function buildStubHeldGH(): string {
  return `#!/bin/sh
case "$1" in
  config) echo https ;;
  *)
    if [ -f "$HOME/gh-hold" ]; then
      touch "$HOME/gh-held"
      while [ -f "$HOME/gh-hold" ]; do sleep 0.05; done
    fi
    echo '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]' ;;
esac
`;
}
