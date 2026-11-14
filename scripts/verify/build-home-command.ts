import { join } from 'node:path';

// The variables `with-test-home.sh` removes: a session atc hosts sets them, and a process that
// keeps one reports to the live daemon of the enclosing session.
const ENCLOSING_SESSION_VARIABLES = [
  'ATC_SESSION_ID',
  'ATC_SOCKET',
  'ATC_BRIDGE',
  'ATC_OUTBOX',
  'ATC_SESSION_RECORD',
  'AUTO_MODE_SCOPE_FILE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_TOOL_CALL_ID',
] as const;

// Runs argv in the run's temp home, as `with-test-home.sh` sets it up. A wringer program or
// stream source only adds variables to the supervisor's, so `env` removes the enclosing
// session's.
export function buildHomeCommand(root: string, argv: readonly string[]): string[] {
  const home = join(root, 'home');

  return [
    'env',
    ...ENCLOSING_SESSION_VARIABLES.flatMap((name) => ['-u', name]),
    `HOME=${home}`,
    `XDG_RUNTIME_DIR=${join(root, 'runtime')}`,
    `XDG_CONFIG_HOME=${join(home, '.config')}`,
    `XDG_DATA_HOME=${join(home, '.local', 'share')}`,
    `XDG_STATE_HOME=${join(home, '.local', 'state')}`,
    `XDG_CACHE_HOME=${join(home, '.cache')}`,
    `GROK_HOME=${join(home, '.grok')}`,
    `CODEX_HOME=${join(home, '.codex')}`,
    `ATC_TEST_HOME=${root}`,
    ...argv,
  ];
}
