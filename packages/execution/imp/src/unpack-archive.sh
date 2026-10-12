# Unpacks a gzipped tar from stdin into a directory on an imp.
# $1: the directory, created when missing.
# $2: the exit code that answers an imp without gzip, checked before the
#     archive is read.
command -v gzip >/dev/null 2>&1 || exit "$2"
mkdir -p "$1" && tar -x -z --no-same-owner -f - -C "$1"
