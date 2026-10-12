/**
 * The script of a stand-in `gh` that is signed in. It appends each command
 * line it runs to `$HOME/gh-argv`. `gh config …` prints `https`. A
 * repository listing of the signed-in account, `gh repo list --limit …`,
 * prints one public repository, `me/dots`, and a listing of an owner,
 * `gh repo list <owner> --limit …`, prints one private repository,
 * `acme/app`, each in the JSON shape `gh repo list` prints.
 */
export function buildStubSignedInGH(): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/gh-argv"
case "$1 $3" in
  "config "*) echo https ;;
  "repo --limit") echo '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]' ;;
  *) echo '[{"nameWithOwner":"acme/app","description":"","isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"}]' ;;
esac
`;
}
