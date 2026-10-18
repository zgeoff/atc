#!/usr/bin/env bash
# Replaces the owner's own domain and home path in the tests with invented
# ones: each host under the domain moves under example.com, and the home path
# becomes /home/me. Takes the names as arguments, so this public file never
# spells them. Run once from the repo root:
#   bash scripts/codemods/geo-1287-owner-names.sh <domain> <login>
set -euo pipefail

domain="${1:?usage: geo-1287-owner-names.sh <domain> <login>}"
login="${2:?usage: geo-1287-owner-names.sh <domain> <login>}"
domain_pattern="${domain//./\\.}"

mapfile -t files < <(git grep -l -E "\\.${domain_pattern}\\b|/home/${login}\\b" -- packages e2e)

for file in "${files[@]}"; do
  sed -i -E \
    -e "s#\\.${domain_pattern}\\b#.example.com#g" \
    -e "s#/home/${login}\\b#/home/me#g" \
    "$file"
done
