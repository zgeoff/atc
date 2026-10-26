#!/usr/bin/env bash
# Prints the newest of the versions on stdin, one per line, and prints
# nothing when stdin holds none. Blank lines are skipped.
#
#   printf '7.10.0\n7.3.1\n' | scripts/pick-newest-version.sh
set -euo pipefail

sed '/^[[:space:]]*$/d' | sort -V | tail -n 1
