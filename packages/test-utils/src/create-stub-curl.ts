import { createStubBin } from './create-stub-bin';

// A stand-in for `curl -fsSL -o <file> <url>` that writes the file in the
// downloads folder named by the URL's last path segment, and fails as -f does
// when the folder holds none.
export function createStubCurl(directory: string, downloads: string): string {
  return createStubBin(
    directory,
    'curl',
    `#!/usr/bin/env bash
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
source="${downloads}/\${url##*/}"
[ -f "$source" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "$source" "$out"
`,
  );
}
