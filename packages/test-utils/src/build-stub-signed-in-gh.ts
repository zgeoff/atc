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
