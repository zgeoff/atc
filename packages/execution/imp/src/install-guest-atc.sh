# shellcheck shell=sh
# Unpacks a gzipped tar from stdin that holds bin/atc into a staging folder
# inside the guest folder, then renames the unpacked atc over bin/atc. The
# rename replaces bin/atc in one step, a link included, so a process that
# runs bin/atc during the copy finds the old atc or the new one, never a
# missing or half-written file. A tar run by a user other than root applies
# that user's umask to the archive's modes, so the script sets the mode itself.
# $1: the guest folder.
# $2: the exit code that answers an imp without gzip, checked before the
#     archive is read.
command -v gzip > /dev/null 2>&1 || exit "$2"
staging="$1/.atc-install.$$"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$1/bin" "$staging" && tar -x -z -f - -C "$staging" && chmod 0755 "$staging/bin/atc" && mv -f "$staging/bin/atc" "$1/bin/atc"
