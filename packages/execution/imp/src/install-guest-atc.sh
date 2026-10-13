# shellcheck shell=sh
# Unpacks a gzipped tar from stdin that holds bin/atc into the guest folder,
# replacing a link at bin/atc first so the copy never writes through it.
# $1: the guest folder.
# $2: the exit code that answers an imp without gzip, checked before the
#     archive is read.
command -v gzip > /dev/null 2>&1 || exit "$2"
mkdir -p "$1" && rm -f "$1/bin/atc" && tar -x -z -f - -C "$1"
