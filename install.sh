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
  *) echo "atc: no binary for $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "atc: no binary for $(uname -m)" >&2; exit 1 ;;
esac

asset="atc-$os-$arch"
url="https://github.com/$repo/releases/latest/download/$asset"

mkdir -p "$dir"
echo "atc: downloading $url"
curl -fsSL "$url" -o "$dir/atc.tmp"
chmod +x "$dir/atc.tmp"
mv "$dir/atc.tmp" "$dir/atc"
echo "atc: installed $("$dir/atc" --version) to $dir/atc"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "atc: add $dir to your PATH" ;;
esac
