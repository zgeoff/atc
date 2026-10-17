// prints `<path>\0F<base64>\0` per path that exists: start files in the resolved dir, then root
// files there, in every dir above and in the worktree's main checkout; `U` replaces `F<base64>`
// for anything not a readable regular file within the size cap, and a missing dir exits 3
export const READ_PROJECT_SETTINGS_SCRIPT = `cd -P -- "$1" 2>/dev/null || exit 3; shift; d=$(pwd -P)
emit() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  if [ -f "$1" ] && n=$(wc -c < "$1" 2>/dev/null) && [ "$n" -le 1048576 ] && b=$(base64 -w0 -- "$1" 2>/dev/null); then printf '%s\\0F%s\\0' "$1" "$b"; else printf '%s\\0U\\0' "$1"; fi
}
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do emit "\${d%/}/$1"; shift; done; [ "$#" -gt 0 ] && shift
m=$(git -c safe.directory='*' -c core.fsmonitor=false rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && m=\${m%/.git} || m=
for n in "$@"; do p=$d; while :; do emit "\${p%/}/$n"; [ "$p" = / ] && break; p=\${p%/*}; [ -n "$p" ] || p=/; done; [ -z "$m" ] || emit "\${m%/}/$n"; done
exit 0`;
