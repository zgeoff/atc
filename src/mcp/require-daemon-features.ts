import type { DaemonFeature } from '../protocol/daemon-features';

// What each feature lets a tool call ask for, as an outdated-daemon refusal
// states it.
const FEATURE_USES: Readonly<Record<DaemonFeature, string>> = {
  'agents.list': 'atc_agents_list',
  'daemon.id': "the daemon's persisted identity",
  'events.more': "atc_events_read's more flag",
  'events.session': "atc_events_read's session filter",
  'message.idempotency': "atc_session_message's idempotencyKey",
  'message.turn': "atc_message_get's turn and answeredWith",
  'message.wait': "atc_message_get's waitMs",
  'session.forget': 'session.forget',
  'session.locator': "a session's locator",
  'session.submit': 'atc_session_input',
  'spawn.idempotency': "atc_session_spawn's idempotencyKey",
  'spawn.options': "atc_session_spawn's model and effort",
  'spawn.target': "atc_session_spawn's target",
  'report.get': 'atc_report_get',
  'request.principal': 'the target limits of a remote MCP client',
  'spawn.workspace': "atc_session_spawn's workspace",
  sources: 'sources.list and sources.interpret',
  'git.probe': 'git.probe',
  'transport.tcp': 'a TCP connection to the daemon',
  'idempotency.replayOnly': 'a resend that only replays a held idempotency key',
};

/**
 * Throws a `daemon_outdated` error when the daemon a request is about to
 * reach lacks a feature the request depends on, rather than letting a daemon
 * that would ignore the option answer as if it had honoured it. atc never
 * restarts the daemon itself: a restart is the operator's call, because it
 * respawns every session.
 */
export function requireDaemonFeatures(
  features: ReadonlySet<DaemonFeature>,
  required: readonly DaemonFeature[],
): void {
  const missing = required.find((feature) => !features.has(feature));

  if (missing === undefined) {
    return;
  }

  throw new Error(
    `daemon_outdated: the running atc daemon is older than this atc and does not support ${FEATURE_USES[missing]}. Restart the daemon to use it: press u in the atc TUI, which restores every session. Until then, call without it.`,
  );
}
