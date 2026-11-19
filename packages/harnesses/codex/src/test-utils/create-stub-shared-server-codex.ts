import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';

interface StubSharedServerCodexConfig {
  readonly atc: readonly string[];

  readonly composer: string;
}

// Codex runs hooks in the background server its first terminal starts, which keeps that
// start's environment. Later starts without --no-daemon report the first start's session
// id and socket.
export function createStubSharedServerCodex(
  directory: string,
  config: StubSharedServerCodexConfig,
): string {
  const report = `${config.atc.map((part) => `"${part}"`).join(' ')} hook-report --agent codex`;
  const server = join(directory, 'codex-shared-server.env');

  return createStubBin(
    directory,
    'fake-codex',
    `#!/usr/bin/env bash
echo "FAKE_CODEX_UP args: $*"
thread="fake-thread-$ATC_SESSION_ID"
source=startup
prev=''
for arg in "$@"; do
  if [ "$prev" = resume ]; then thread="$arg"; source=resume; fi
  prev="$arg"
done
case " $* " in
  *' --no-daemon '*) ;;
  *)
    (set -o noclobber; printf 'ATC_SESSION_ID=%q\\nATC_SOCKET=%q\\n' "$ATC_SESSION_ID" "$ATC_SOCKET" > '${server}') 2>/dev/null
    . '${server}'
    ;;
esac
printf '{"hook_event_name":"SessionStart","session_id":"%s","source":"%s"}' "$thread" "$source" | ${report}
printf '{"hook_event_name":"Stop","session_id":"%s","last_assistant_message":"done %s"}' "$thread" "$thread" | ${report}
exec "${process.execPath}" "${config.composer}"
`,
  );
}
