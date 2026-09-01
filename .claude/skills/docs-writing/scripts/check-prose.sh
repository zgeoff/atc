#!/usr/bin/env bash
# Greps committed docs for prose violations; exits non-zero when any are found.
# Violation greps fail the run; candidate greps print for judgment and never fail it.
# Usage (from the repo root): check-prose.sh <path>...
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: check-prose.sh <path>..." >&2
  exit 2
fi

# The skill's own files document the forbidden patterns and contain them as examples.
set -- "$@" ':(exclude).claude/skills/docs-writing'

fail=0

report() {
  local label=$1 out=$2
  if [ -n "$out" ]; then
    fail=1
    printf '%s\n%s\n\n' "$label" "$out"
  fi
}

candidate() {
  local label=$1 out=$2
  if [ -n "$out" ]; then
    printf '%s\n%s\n\n' "$label" "$out"
  fi
}

report 'Process residue (date stamps, investigation framing, memory citations, §):' \
  "$(git grep -nP 'Verified 20[0-9]{2}-|Investigation count|\(see memory |\([0-9]{2,4}-[0-9]{2}-[0-9]{2}\)|^Mitigation:|§' -- "$@")"

# AGENTS.md owns the banned-words list; keep this pattern in sync. Judgment-only bans
# (bites, floor, anchor) are not grepped. CAS stays case-sensitive so "CAs" passes.
report 'Banned words (judge each match — the AGENTS.md registry and markdown-fence senses are legal):' \
  "$(git grep -nPi '\bsurfaces?\b|load-bearing|\bseams?\b|\bceilings?\b|\bfenc(e|es|ed|ing)\b|(?-i:\bCAS\b)|significantly|near-instant' -- "$@")"

report 'Filler with no term-of-art use:' \
  "$(git grep -nPi 'organically|earns its complexity|cheap insurance|lays (the )?foundation|the right level' -- "$@")"

report 'Possessive on a markdown link:' \
  "$(git grep -nE "\]\([^)]*\)'s" -- "$@")"

report 'Role-label headings:' \
  "$(git grep -nE '^#{2,4} (Overview|Notes|Details|Rationale)$' -- "$@")"

report '"Should succeed" in a procedure — state the expected outcome instead:' \
  "$(git grep -nPi 'should (succeed|work|pass)\b' -- "$@")"

report 'Number joined to its unit ("64KB"; write "64 KB"; code blocks are exempt):' \
  "$(git grep -nP '\b[0-9]+(KB|MB|GB|TB|KiB|MiB|GiB|ms)\b' -- "$@")"

report 'Horizontal rules outside YAML frontmatter:' \
  "$(git ls-files -- "$@" | grep '\.md$' | xargs -r awk \
    'FNR==1{fm=($0=="---")} fm&&FNR>1&&$0=="---"{fm=0;next} !fm&&$0=="---"{print FILENAME": "FNR}')"

report 'Untagged code fences:' \
  "$(git ls-files -- "$@" | grep '\.md$' | xargs -r awk \
    'FNR==1{n=0} /^```/{n++; if (n%2==1 && $0=="```") print FILENAME": "FNR}')"

candidate 'Candidates — filler words with term-of-art uses; cull the filler, keep the terms:' \
  "$(git grep -nPi '\b(naturally|cleanly|trivially|easy|simple|quick)\b' -- "$@")"

candidate 'Candidates — speech verbs on data artifacts; the artifact holds, includes, returns, or matches:' \
  "$(git grep -nPi '(?<!file |table |column |export |bucket |method |variable |test )\b(names|says|tells|answers|knows|promises)\b(?! (rot|and locations|only))' -- "$@")"

candidate 'Candidates — delta-framing words; legal only when the baseline sits in the same doc:' \
  "$(git grep -nPi '(^|\. )(Also|Additionally|In addition),? |\b(already|today|before this work|as it does today)\b' -- "$@")"

candidate 'Candidates — headings written as claims; move the thesis into the first sentence:' \
  "$(git grep -nP '^#{2,4} (?!(What|Why|When|How|Before|Where|Which)\b).*\b(is|are|does|has|cannot|never|not)\b' -- "$@")"

if [ "$fail" -eq 0 ]; then
  echo 'check-prose: clean (candidates above, if any, need judgment only)'
fi

exit "$fail"
