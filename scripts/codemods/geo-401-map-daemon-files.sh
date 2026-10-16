#!/usr/bin/env bash
# Records in the package maps the daemon modules the maps leave out, so the
# daemon package move takes every module under packages/app/src/daemon. Each
# module takes a row in the file and stage maps, in the app until wave 7 and
# in its daemon folder after, and its test, when it has one, a row in the
# test map beside it. A module or test the maps already hold at its wave 6
# path keeps its row, so a second run changes nothing. It also records that
# runGH lives in plugin-api, which the daemon and the GitHub source both use.
# Usage: bash scripts/codemods/geo-401-map-daemon-files.sh
set -euo pipefail

# module under packages/app/src/daemon, daemon folder it lands in
MODULES=(
  'apply-menu-choice sessions'
  'auth-setup auth'
  'build-bridge-tap-client sessions'
  'build-legacy-message-hashes transport'
  'build-menu-view sessions'
  'build-message-sender sessions'
  'build-notice-trail-entry sessions'
  'build-scoped-context auth'
  'context-member-scopes auth'
  'expand-screen-menu sessions'
  'find-parent-pid transport'
  'find-peer-session transport'
  'format-auth-notice auth'
  'format-restore-refusal fleet'
  'harness-exit-transitions sessions'
  'host-dir-claims sessions'
  'menu-terminal sessions'
  'message-caller sessions'
  'read-known-menu sessions'
  'read-peer-pid transport'
  'read-whole-menu sessions'
  'run-spawn-steps sessions'
  'send-menu-key sessions'
  'session sessions'
  'session-adopter sessions'
  'session-callbacks sessions'
  'session-changes sessions'
  'session-event-kind sessions'
  'session-fleet-writer fleet'
  'session-harnesses sessions'
  'session-killer sessions'
  'session-registry sessions'
  'session-restorer fleet'
  'session-spawner sessions'
  'spawn-rollback sessions'
  'split-screen-menu sessions'
  'testing/build-stub-binder-broker testing'
  'testing/build-stub-credential-broker testing'
  'testing/build-stub-harness-adapter testing'
  'testing/build-stub-local-provider testing'
  'testing/build-stub-memory-provider testing'
  'testing/build-stub-pregranted-broker-host testing'
  'testing/build-stub-restore-imp-provider testing'
  'testing/build-stub-targets testing'
  'testing/run-local-command testing'
  'wait-for-menu-poll sessions'
  'wait-for-menu-quiet sessions'
  'with-owner-only-socket transport'
)

APP=packages/app/src/daemon
MAPS=scripts/package-map

# Whether a map holds a row whose path in the named column is the path given.
has_row() {
  awk -F'\t' -v column="$2" -v path="$3" '
    NR == 1 { for (i = 1; i <= NF; i++) if ($i == column) at = i; next }
    $at == path { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

for row in "${MODULES[@]}"; do
  read -r module folder <<< "$row"

  app="${APP}/${module}"
  final="packages/daemon/src/${folder}/${module##*/}"

  if ! has_row "$MAPS/package-filemap.tsv" target "${final}.ts"; then
    printf '%s.ts\tdaemon\t%s\t%s.ts\t\n' "$app" "$folder" "$final" >> "$MAPS/package-filemap.tsv"
  fi

  if ! has_row "$MAPS/package-stagemap.tsv" path_wave6 "${app}.ts"; then
    {
      printf '%s.ts\tdaemon' "$app"
      printf '\tapp%.0s' 1 2 3 4 5 6
      printf '\tdaemon%.0s' 7 8
      printf "\t${app}.ts%.0s" 1 2 3 4 5 6
      printf "\t${final}.ts%.0s" 7 8
      printf '\n'
    } >> "$MAPS/package-stagemap.tsv"
  fi
done

# Each module the daemon takes at wave 7 whose test sits beside it at
# wave 6 takes that test with it, so the test gets a row beside the module
# when the test map holds none. This covers the modules above and the
# modules the maps held from the start alike.
awk -F'\t' '
  NR == 1 { for (i = 1; i <= NF; i++) { if ($i == "path_wave6") now = i; if ($i == "path_wave7") next_ = i }; next }
  $next_ ~ /^packages\/daemon\// { print $now "\t" $next_ }
' "$MAPS/package-stagemap.tsv" | while IFS=$'\t' read -r now next; do
  test_now="${now%.ts}.test.ts"
  test_next="${next%.ts}.test.ts"

  if [[ -f "$test_now" ]] && ! has_row "$MAPS/package-testmap.tsv" path_wave6 "$test_now"; then
    {
      printf '%s\tdaemon\tdaemon\tbeside its module\t%s' "$test_now" "$test_next"
      printf "\t${test_now}%.0s" 1 2 3 4 5 6
      printf "\t${test_next}%.0s" 7 8
      printf '\n'
    } >> "$MAPS/package-testmap.tsv"
  fi
done

# A daemon test whose cases all moved to an e2e/ journey, since each one
# started a whole daemon, no longer sits beside its module, so its row goes.
for test in daemon apply-menu-choice; do
  sed -i "\#^\(src/daemon\|packages/app/src/daemon\)/${test}\.test\.ts	#d" "$MAPS/package-testmap.tsv"
done

# The stub targets left the app's test-utils for the daemon's testing folder,
# whose row the table adds, so the row at the old path goes.
for map in package-stagemap package-testmap; do
  sed -i '\#^src/test-utils/build-stub-targets\(\.test\)\?\.ts	#d' "$MAPS/${map}.tsv"
done

# The two helpers that start a daemon on the local pseudo-terminal provider
# stay in the app's test-utils, since the daemon package may not load that
# provider: their package is app, and their paths keep the wave 6 path.
for helper in start-test-daemon run-listener-daemon; do
  for map in package-filemap package-stagemap package-testmap; do
    awk -F'\t' -v OFS='\t' -v helper="$helper" '
      NR == 1 {
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^(path_wave[78]|target)$/) path[i] = 1
          if ($i ~ /^(package|final|module_package|placed_in|wave[78])$/) pkg[i] = 1
          if ($i == "folder") at_folder = i
        }
      }
      NR > 1 && $1 ~ ("^src/test-utils/" helper "(\\.test)?\\.ts$") {
        for (i in path) sub("packages/daemon/src/testing/", "packages/app/src/test-utils/", $i)
        for (i in pkg) if ($i == "daemon") $i = "app"
        if (at_folder) $at_folder = "test-utils"
      }
      { print }
    ' "$MAPS/${map}.tsv" > "$MAPS/${map}.tsv.tmp"
    mv "$MAPS/${map}.tsv.tmp" "$MAPS/${map}.tsv"
  done
done

# runGH moves from the GitHub source to plugin-api at wave 6: its package
# and its paths from wave 6 on change, and the earlier waves keep theirs
gh_old=packages/sources/github/src/run-gh
gh_new=packages/plugin-api/src/run-gh
gh_note='in plugin-api: the GitHub source and the daemon (check-session-scope) both use it'

for map in package-filemap package-stagemap package-testmap; do
  awk -F'\t' -v OFS='\t' -v old="$gh_old" -v new="$gh_new" -v note="$gh_note" '
    NR == 1 {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^(path_wave[678]|target)$/) path[i] = 1
        if ($i ~ /^(package|final|module_package|placed_in|wave[678])$/) pkg[i] = 1
        if ($i == "split_or_note") at_note = i
      }
    }
    NR > 1 && $1 ~ /^src\/sources\/github\/run-gh(\.test)?\.ts$/ {
      for (i in path) sub(old, new, $i)
      for (i in pkg) if ($i == "source-github") $i = "plugin-api"
      if (at_note) $at_note = note
    }
    { print }
  ' "$MAPS/${map}.tsv" > "$MAPS/${map}.tsv.tmp"
  mv "$MAPS/${map}.tsv.tmp" "$MAPS/${map}.tsv"
done
