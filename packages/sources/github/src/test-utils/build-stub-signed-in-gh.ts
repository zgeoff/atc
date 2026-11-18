export function buildStubSignedInGH(): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/gh-argv"
case "$1 $3" in
  "config "*) echo https ;;
  "api "*) echo '[{"full_name":"me/dots","description":"dotfiles","private":false,"html_url":"https://github.com/me/dots","ssh_url":"git@github.com:me/dots.git"}]' ;;
  *) echo '[{"nameWithOwner":"acme/app","description":"","isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"}]' ;;
esac
`;
}
