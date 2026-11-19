export const NO_TRANSCRIPT_CODE = 3;

// dd's POSIX options skip and count only whole blocks, and GNU's byte offsets are missing on macOS.
export const BLOCK_BYTES = 65_536;

// GNU base64 wraps its output and macOS's does not, so the blocks come last and may span lines.
export const RESPONSE_FIELDS = [
  { name: 'size', value: '"$((size))"', pattern: String.raw`\d+` },
  { name: 'blocks', value: '"$blocks"', pattern: String.raw`[\d+/=A-Za-z\n]*` },
] as const;

// dd writes to a temp file instead of a pipe because a pipeline reports only its last command's
// exit status, so a dd failure or a broken pipe from a reader that quits early would go unseen.
export const READ_TRANSCRIPT_WINDOW_SCRIPT = `[ -f "$1" ] || exit ${NO_TRANSCRIPT_CODE}
size=$(wc -c < "$1") || exit 1
window=$(mktemp) || exit 1
trap 'rm -f "$window"' EXIT
dd if="$1" of="$window" bs=${BLOCK_BYTES} skip="$2" count="$3" || exit 1
blocks=$(base64 < "$window") || exit 1
printf '${RESPONSE_FIELDS.map(() => '%s').join(String.raw`\n`)}\\n' ${RESPONSE_FIELDS.map((field) => field.value).join(' ')}`;
