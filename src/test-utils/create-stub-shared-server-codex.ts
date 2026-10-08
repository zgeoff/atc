import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

interface StubSharedServerCodexConfig {
  // The command atc runs as; the stub reports each hook through its
  // `hook-report --agent codex`, as the hook entries atc prints for Codex do.
  readonly atc: readonly string[];

  // The composer script the stub finishes in.
  readonly composer: string;
}

/**
 * Creates a stand-in for a Codex CLI that shares one background server
 * between its terminals, as `fake-codex` under the directory, and returns
 * its path. Without `--no-daemon`, the first start records its own
 * `ATC_SESSION_ID` and `ATC_SOCKET` in `codex-shared-server.env` under the
 * directory, as the server it starts keeps its environment, and every start
 * runs its hooks with the recorded pair, as Codex runs hooks inside that
 * server. With `--no-daemon`, a start runs its hooks with its own pair. The
 * stub prints its arguments, reports a `SessionStart` for its thread, which
 * is `fake-thread-<its own ATC_SESSION_ID>` or the id after `resume`, then
 * a `Stop` whose last message is `done <thread>`, then runs the composer.
 */
export function createStubSharedServerCodex(
  dir: string,
  config: StubSharedServerCodexConfig,
): string {
  const report = `${config.atc.map((part) => `"${part}"`).join(' ')} hook-report --agent codex`;
  const server = join(dir, 'codex-shared-server.env');

  return createStubBin(
    dir,
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
