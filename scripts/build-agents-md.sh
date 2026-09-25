#!/usr/bin/env bash
# Concatenates a shared and a project partial into a generated AGENTS.md.
# Usage: build-agents-md.sh <shared-partial> <project-partial> <output>
set -euo pipefail

shared="$1"
project="$2"
out="$3"

for partial in "$shared" "$project"; do
  if [ ! -f "$partial" ]; then
    echo "build-agents-md: $partial is missing. Create it before building $out." >&2
    exit 1
  fi
done

{
  echo '<!-- Generated file — do not edit. Edit agents/project.md here, or agents/shared.md in zgeoff/tools. -->'
  echo
  cat "$shared"
  echo
  cat "$project"
} > "$out"
