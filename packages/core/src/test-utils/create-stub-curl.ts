import { createStubBin } from './create-stub-bin';

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
