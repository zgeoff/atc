/**
 * The script of a stand-in `gh` whose repository listing waits for the
 * test. `gh config …` prints `https`. Any other command waits while
 * `$HOME/gh-hold` exists, touching `$HOME/gh-held` on each pass of the
 * wait, so the marker appears only once the stand-in is held, then prints
 * one repository, `me/dots`, in the JSON shape `gh repo list` prints.
 */
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
