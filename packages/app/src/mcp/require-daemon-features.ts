import type { DaemonFeature } from '@atc/protocol/daemon-features';

// What each feature lets a tool call ask for, as an outdated-daemon refusal
// states it.
const FEATURE_USES: Readonly<Record<DaemonFeature, string>> = {
  'agents.list': 'atc_spawn_options_get',
  'daemon.id': "the daemon's persisted identity",
  'events.more': "atc_events_read's more flag",
  'events.session': "atc_events_read's session filter",
  'message.idempotency': "atc_message_send's idempotencyKey",
  'message.sender': 'the sender atc labels each message of atc_message_send with',
  'message.notice': 'the answer notices a sending session takes through its tap',
  'message.local': 'the local sender label and the notice flag of session.message',
  'message.turn': "atc_message_get's turn and answeredWith",
  'message.unanswered':
    'the unanswered status in the results of atc_message_send and atc_message_get',
  'message.wait': "atc_message_get's waitMs",
  'session.forget': 'atc_session_forget',
  'session.forget.preconditions': "atc_session_forget's pinned and live checks in the daemon",
  'session.locator': "a session's locator",
  'session.menu': 'atc_terminal_choose',
  'session.submit': 'atc_terminal_type',
  'spawn.idempotency': "atc_session_spawn's idempotencyKey",
  'spawn.options': "atc_session_spawn's model and effort",
  'spawn.target': "atc_session_spawn's target",
  'note.get': "atc_events_read's full note texts",
  'answer.get': "atc_events_read's full answers",
  'request.principal': 'the target limits of a remote MCP client',
  'spawn.workspace': "atc_session_spawn's workspace",
  'spawn.workspace.trust': "atc_session_spawn's trustClonedWorkspace",
  'spawn.workspace.autoDir': "atc_session_spawn's git workspace without a cwd",
  sources: 'sources.list and sources.interpret',
  'git.probe': 'git.probe',
  'transport.tcp': 'a TCP connection to the daemon',
  'idempotency.replayOnly': 'a resend that only replays a held idempotency key',
  'session.auth': 'atc_session_auth_rebind, session.auth.revoke and session.auth.rebind',
  'session.kill.stopOnly': 'atc_session_stop',
  'session.record': "atc_session_scope_add and atc_session_spawn's scope",
  'session.update.parent': "atc_session_update's parent",
  'session.update.renameSkipped': "atc_session_update's report of a skipped rename",
  'vocabulary.note':
    'the note and queued words in the results of atc_events_read, atc_message_send, and atc_message_get',
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
