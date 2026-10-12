#!/bin/sh
# Installs the latest atc release binary for this machine into ~/.local/bin
# (or the directory in ATC_INSTALL_DIR). No Bun or Node is needed.
#
#   curl -fsSL https://raw.githubusercontent.com/zgeoff/atc/main/install.sh | sh
set -eu

repo="zgeoff/atc"
dir="${ATC_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "atc: no binary for $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *)
    echo "atc: no binary for $(uname -m)" >&2
    exit 1
    ;;
esac

asset="atc-$os-$arch"
base="https://github.com/$repo/releases/latest/download"
url="$base/$asset"

mkdir -p "$dir"
echo "atc: downloading $url"
curl -fsSL "$url" -o "$dir/atc.tmp"

# The release publishes SHA256SUMS beside the binaries; the binary is moved
# into place only when its hash matches the line for this asset.
expected=$(curl -fsSL "$base/SHA256SUMS" | awk -v asset="$asset" '$2 == asset { print $1 }')

if command -v sha256sum > /dev/null 2>&1; then
  actual=$(sha256sum "$dir/atc.tmp" | cut -d ' ' -f 1)
elif command -v shasum > /dev/null 2>&1; then
  actual=$(shasum -a 256 "$dir/atc.tmp" | cut -d ' ' -f 1)
else
  rm -f "$dir/atc.tmp"
  echo "atc: needs sha256sum or shasum to check the download" >&2
  exit 1
fi

if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
  rm -f "$dir/atc.tmp"
  echo "atc: $asset does not match the release's SHA256SUMS" >&2
  exit 1
fi

chmod +x "$dir/atc.tmp"
mv "$dir/atc.tmp" "$dir/atc"
echo "atc: installed $("$dir/atc" --version) to $dir/atc"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "atc: add $dir to your PATH" ;;
esac
