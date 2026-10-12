# shellcheck shell=sh
# Readies the guest folder, prints the version of the image's atc and of
# the atc at bin/atc, one per line and empty for one that is missing, and
# links bin/atc to the image's atc when that one prints the daemon's
# version and lives elsewhere.
# $1: the guest folder.
# $2: the image's atc.
# $3: the daemon's version.
mkdir -p "$1/run" "$1/bin" || exit 1
image=$("$2" --version 2> /dev/null) || image=
copied=$("$1/bin/atc" --version 2> /dev/null) || copied=
printf '%s\n%s\n' "$image" "$copied"
[ -n "$image" ] && [ "$image" = "$3" ] || exit 0
[ "$2" = "$1/bin/atc" ] || ln -sfn "$2" "$1/bin/atc"
