#!/usr/bin/env bash
# Prints the Homebrew formula for one released version, reading each
# platform's checksum from the SHA256SUMS the binary build wrote.
#
#   scripts/build-formula.sh <version> <path to SHA256SUMS>
set -euo pipefail

version="$1"
sums="$2"

sha() {
  awk -v name="atc-$1" '$2 == name { print $1 }' "$sums"
}

base="https://github.com/zgeoff/atc/releases/download/@zgeoff/atc@$version"

cat <<FORMULA
class Atc < Formula
  desc "Terminal control tower for coding-agent sessions"
  homepage "https://github.com/zgeoff/atc"
  version "$version"
  license "MIT"

  on_macos do
    on_arm do
      url "$base/atc-darwin-arm64"
      sha256 "$(sha darwin-arm64)"
    end
    on_intel do
      url "$base/atc-darwin-x64"
      sha256 "$(sha darwin-x64)"
    end
  end

  on_linux do
    on_arm do
      url "$base/atc-linux-arm64"
      sha256 "$(sha linux-arm64)"
    end
    on_intel do
      url "$base/atc-linux-x64"
      sha256 "$(sha linux-x64)"
    end
  end

  def install
    binary = Dir["atc-*"].first
    bin.install binary => "atc"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/atc --version")
  end
end
FORMULA
