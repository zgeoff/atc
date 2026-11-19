export const UNPACK_ARCHIVE_SCRIPT = 'cd && mkdir -p "$1" && tar -x --no-same-owner -f - -C "$1"';
