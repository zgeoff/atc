# shellcheck shell=sh
# Readies the guest folder, prints the version of the image's atc, the
# version of the atc at bin/atc and the signature of the image's atc, one per
# line and empty for one that is missing, and links bin/atc to the image's
# atc when that one prints the daemon's version and lives elsewhere. An
# image's atc whose signature matches the known one takes the known version
# without running, since a cold start of it takes most of a second.
# $1: the guest folder.
# $2: the image's atc.
# $3: the daemon's version.
# $4: the signature of an image's atc whose version is known, or empty.
# $5: that version, or empty.
mkdir -p "$1/run" "$1/bin" || exit 1
path=$(readlink -f "$2" 2> /dev/null) &&
  stat=$(stat -c '%i %s %y' "$path" 2> /dev/null) &&
  signature="$path $stat" || signature=
if [ -n "$signature" ] && [ "$signature" = "$4" ] && [ -n "$5" ] && [ -x "$2" ]; then
  image=$5
else
  image=$("$2" --version 2> /dev/null) || image=
fi
copied=$("$1/bin/atc" --version 2> /dev/null) || copied=
printf '%s\n%s\n%s\n' "$image" "$copied" "$signature"
[ -n "$image" ] && [ "$image" = "$3" ] || exit 0
[ "$2" = "$1/bin/atc" ] || ln -sfn "$2" "$1/bin/atc"
