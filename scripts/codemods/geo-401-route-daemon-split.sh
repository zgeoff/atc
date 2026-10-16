#!/usr/bin/env bash
# Records one daemon split ticket in the package maps and moves its topic
# tests. Each topic test drives a whole daemon over its socket, so it moves
# to e2e/ as a daemon protocol journey: its rows in the test map take the
# e2e/ path from wave 6 on, it leaves the test-placement allowlist in
# .oxlintrc.json, and run-wave-move.ts moves it and rewrites its imports.
# Each module the ticket extracts takes a row in the file and stage maps,
# in the app until wave 7 and in its daemon folder after, and its test a
# row in the test map beside it. A second run changes nothing.
# Usage: bash scripts/codemods/geo-401-route-daemon-split.sh <ticket>
set -euo pipefail

ticket="${1:?usage: geo-401-route-daemon-split.sh <ticket>}"

# ticket, topic test under packages/app/src/daemon, journey under e2e/
TESTS=(
  '16a daemon-agent-kinds spawn-agent-kinds'
  '16a daemon-agent-registry spawn-agent-registry'
  '16a daemon-agents spawn-agents'
  '16a daemon-codex-guest-auth spawn-codex-guest-auth'
  '16a daemon-gateway-guest-auth spawn-gateway-guest-auth'
  '16a daemon-gateway-workspace-trust spawn-gateway-workspace-trust'
  '16a daemon-idempotency spawn-idempotency'
  '16a daemon-imp-guest spawn-imp-guest'
  '16a daemon-imp-placement spawn-imp-placement'
  '16a daemon-imp-project-settings spawn-imp-project-settings'
  '16a daemon-imp-workspace spawn-imp-workspace'
  '16a daemon-imp spawn-imp'
  '16a daemon-last-used spawn-last-used'
  '16a daemon-local-workspace-trust spawn-local-workspace-trust'
  '16a daemon-provider spawn-provider'
  '16a daemon-sources spawn-sources'
  '16a daemon-targets spawn-targets'
  '16a daemon-workspace spawn-workspace'
  '16b daemon-answer-notices message-answer-notices'
  '16b daemon-messages message-delivery'
  '16c daemon-codex-app-server bridge-codex-app-server'
  '16c daemon-event-sweep hook-event-sweep'
  '16c daemon-events hook-events'
  '16c daemon-headless hook-headless'
  '16c daemon-hook-agent hook-agent'
  '16c daemon-imp-bridge bridge-imp'
  '16d daemon-permission-pending session-permission-pending'
  '16d daemon-resume-command session-resume-command'
  '16d daemon-session-record session-record'
  '16e daemon-detector detection-screen'
  '16f daemon-forget session-forget'
  '16g daemon-fleet fleet-stored'
  '16g daemon-fleet-restart fleet-restart'
  '16h daemon-auth-gateway auth-gateway'
  '16h daemon-config-file config-file'
  '16h daemon-connection-reach transport-connection-reach'
  '16h daemon-principals auth-principals'
  '16h daemon-runtime-auth auth-runtime'
  '16h daemon-tcp transport-tcp'
)

# ticket, topic test an earlier change folded into its module's own test,
# whose test map row goes
FOLDED=(
  '16g restore-fleet-imp-identity'
  '16g restore-fleet-imp'
  '16g restore-fleet-stop'
)

# ticket, module under packages/app/src/daemon, daemon folder it lands in
MODULES=(
  '16a spawn-catalog sources'
  '16a spawn-replay sessions'
  '16a spawn-service sessions'
  '16b build-message-owner sessions'
  '16b emit-inbox-closed sessions'
  '16b message-refused-error sessions'
  '16b message-service sessions'
  '16c event-trail transport'
  '16c hook-intake sessions'
  '16c message-bridges sessions'
  '16c start-event-sweep transport'
  '16c testing/build-stub-message-bridges testing'
  '16d get-descriptor sessions'
  '16d has-resumable-transcript sessions'
  '16d session-handoff sessions'
  '16d session-input sessions'
  '16d session-output sessions'
  '16d session-reads sessions'
  '16e permission-prompts sessions'
  '16e screen-detection sessions'
  '16f confirm-tokens sessions'
  '16f session-forgetter sessions'
  '16g fleet-restorer fleet'
  '16g update-ended-fleet-messages fleet'
  '16h build-bind-refusal transport'
  '16h check-tcp-hello transport'
  '16h connection-view transport'
  '16h listen-options transport'
  '16h plan-binding-reconcile auth'
  '16h plan-binding-verify auth'
  '16h plan-launch-admission auth'
  '16h plan-ready-update auth'
  '16h plan-rebind-start auth'
  '16h require-listen-tokens transport'
  '16h tcp-peer transport'
  '16h try-reconcile-auth-bindings auth'
  '16h try-remove-expired-idempotency-keys transport'
)

APP=packages/app/src/daemon
MAPS=scripts/package-map

for row in "${FOLDED[@]}"; do
  read -r owner topic <<< "$row"

  if [[ "$owner" == "$ticket" ]]; then
    sed -i "\#^src/daemon/${topic}.test.ts	#d" "$MAPS/package-testmap.tsv"
  fi
done

for row in "${TESTS[@]}"; do
  read -r owner topic journey <<< "$row"

  if [[ "$owner" != "$ticket" ]]; then
    continue
  fi

  e2e="e2e/${journey}.test.ts"
  rule="daemon protocol journey: drives a whole daemon over its socket, so ticket ${ticket} moved it to e2e/"

  awk -F'\t' -v OFS='\t' -v test="src/daemon/${topic}.test.ts" -v e2e="$e2e" -v rule="$rule" '
    $1 == test { $4 = rule; $5 = e2e; $11 = e2e; $12 = e2e; $13 = e2e }
    { print }
  ' "$MAPS/package-testmap.tsv" > "$MAPS/package-testmap.tsv.tmp"
  mv "$MAPS/package-testmap.tsv.tmp" "$MAPS/package-testmap.tsv"

  # a topic test the map never held takes a row of its own
  if ! grep -q "^src/daemon/${topic}.test.ts	" "$MAPS/package-testmap.tsv"; then
    old="${APP}/${topic}.test.ts"
    printf 'src/daemon/%s.test.ts\tdaemon\tdaemon\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$topic" "$rule" "$e2e" "$old" "$old" "$old" "$old" "$old" "$e2e" "$e2e" "$e2e" \
      >> "$MAPS/package-testmap.tsv"
  fi

  # the entry goes with or without its comma, and an entry that ended the
  # list leaves the comma of the one before it, which the list then drops
  sed -i "\#^ *\"${APP}/${topic}.test.ts\",\?\$#d" .oxlintrc.json
  perl -0pi -e 's/,(\n\s*\])/$1/g' .oxlintrc.json
done

# the allowlist override goes once the last topic test leaves it
perl -0pi -e 's/,\n    \{\n      \/\/ the daemon\.ts topic tests:[^{}]*?"files": \[\n\s*\],\n      "rules": \{\n[^{}]*?\}\n    \}(\n  \])/$1/' .oxlintrc.json

for row in "${MODULES[@]}"; do
  read -r owner module folder <<< "$row"

  if [[ "$owner" != "$ticket" ]]; then
    continue
  fi

  app="${APP}/${module}"
  final="packages/daemon/src/${folder}/${module##*/}"

  if ! grep -q "^${app}.ts	" "$MAPS/package-filemap.tsv"; then
    printf '%s.ts\tdaemon\t%s\t%s.ts\t\n' "$app" "$folder" "$final" >> "$MAPS/package-filemap.tsv"
  fi

  if ! grep -q "^${app}.ts	" "$MAPS/package-stagemap.tsv"; then
    {
      printf '%s.ts\tdaemon' "$app"
      printf '\tapp%.0s' 1 2 3 4 5 6
      printf '\tdaemon%.0s' 7 8
      printf "\t${app}.ts%.0s" 1 2 3 4 5 6
      printf "\t${final}.ts%.0s" 7 8
      printf '\n'
    } >> "$MAPS/package-stagemap.tsv"
  fi

  # a module that holds only types has no test, so it takes no test row
  if [[ -f "${app}.test.ts" ]] && ! grep -q "^${app}.test.ts	" "$MAPS/package-testmap.tsv"; then
    {
      printf '%s.test.ts\tdaemon\tdaemon\tbeside its module\t%s.test.ts' "$app" "$final"
      printf "\t${app}.test.ts%.0s" 1 2 3 4 5 6
      printf "\t${final}.test.ts%.0s" 7 8
      printf '\n'
    } >> "$MAPS/package-testmap.tsv"
  fi
done

bun scripts/run-wave-move.ts 6
