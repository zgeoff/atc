// $1: the directory, created when missing, entered from the home when relative. Unpacks the tar
// on stdin into it as the sprite's user.
export const UNPACK_ARCHIVE_SCRIPT = 'cd && mkdir -p "$1" && tar -x --no-same-owner -f - -C "$1"';
