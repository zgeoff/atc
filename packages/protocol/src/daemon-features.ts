export const DAEMON_FEATURES = [
  // `agents.list` exists.
  'agents.list',

  // `events.read` returns `more`.
  'events.more',

  // `events.read` takes a `session` filter.
  'events.session',

  // `message.get` returns `turn` and `answeredWith`.
  'message.turn',

  // `message.get` takes `waitMs`.
  'message.wait',

  // `session.spawn` takes `model` and `effort`, and `agents.list` returns
  // `spawnOptions`.
  'spawn.options',

  // `daemon.hello` returns `daemonID`.
  'daemon.id',

  // Every session descriptor holds a `locator`.
  'session.locator',

  // `session.spawn` takes `idempotencyKey`.
  'spawn.idempotency',

  // `session.message` takes `idempotencyKey`.
  'message.idempotency',

  // `session.spawn` takes `target`, and `agents.list` returns `targets`,
  // `spawnDefaults`, `configRevision`, and `targetErrors`.
  'spawn.target',

  // A request takes `as`, the principal it acts as, and `daemon.hello`
  // takes `principal`, the principal the whole connection acts as.
  'request.principal',

  // `session.spawn` takes `workspace`, and a session descriptor holds the
  // `workspace` its checkout was materialized from.
  'spawn.workspace',

  // `session.spawn` takes an explicit trust decision for a cloned imp workspace.
  'spawn.workspace.trust',

  // `session.spawn` with a git workspace takes no `cwd`, and the daemon
  // picks a directory under the target user's home that no other
  // workspace holds.
  'spawn.workspace.autoDir',

  // `session.forget` exists, and a kill of a session asleep on a target that
  // can destroy its host answers `confirmation_required`.
  'session.forget',

  // `session.forget` takes `refusePinned` and `refuseLive`, checked in the
  // same step that forgets, and refuses with `session_pinned` or
  // `session_live`.
  'session.forget.preconditions',

  // `session.submit` exists.
  'session.submit',

  // `note.get` exists.
  'note.get',

  // `answer.get` exists, and the trail holds the whole answer of a message
  // answered since.
  'answer.get',

  // `sources.list` and `sources.interpret` exist, and `agents.list` returns
  // `sources`.
  'sources',

  // `git.probe` exists, and `session.spawn` takes a git workspace with both
  // `ref` and `sha`.
  'git.probe',

  // The daemon can serve the client protocol on a TCP listener whose
  // handshake takes a bearer token.
  'transport.tcp',

  // A keyed `session.spawn` or `session.message` takes `replayOnly`, which
  // replays a key the daemon holds and refuses one it does not hold with
  // `idempotency_key_unknown`, running nothing.
  'idempotency.replayOnly',

  // `session.auth.revoke` and `session.auth.rebind` exist, open to the
  // daemon's owner only.
  'session.auth',

  // Every session has a published record: `session.spawn` takes `scope`,
  // `session.scope.add` exists, `session.get` returns `sessionRecord`, and
  // `daemon.hello` takes `session`, the session the client runs inside.
  'session.record',

  // Events, notes, and messages use the note and queued vocabulary.
  'vocabulary.note',

  // `session.kill` takes `stopOnly`, which stops a live session and leaves an
  // exited one as it is, and answers `{ stopped }`.
  'session.kill.stopOnly',

  // `message.get` and `session.message` can return status `unanswered`, with
  // `unansweredAt` and `unansweredReason`.
  'message.unanswered',

  // `session.update` takes `parent: null`, which makes a sub-session
  // top-level.
  'session.update.parent',

  // `session.update` answers `renameSkipped: 'agent_named'` when it skips a
  // rename because the agent named the session itself.
  'session.update.renameSkipped',

  // `session.tap` takes `notices`, a tap that sets it takes `InboxNotice`
  // events, and `notice.ack` exists.
  'message.notice',

  // `session.message` labels a sender the daemon builds and ignores `from`, a
  // request takes `asName` beside `as`, and `message.get` and the
  // `SessionMessage` and `InboxMessage` events return `sender`.
  'message.sender',

  // `session.message` labels a caller outside every session with no atc build
  // `local`, named by its `from` or else its handshake's client, and takes
  // `notice: false`, which queues no answer notice for the sending session.
  'message.local',

  // `session.menu` and `session.choose` exist: a client reads the menu a
  // session's agent waits on and picks one of its options, or presses
  // Escape on it.
  'session.menu',

  // `daemon.backup` exists, open to the daemon's owner only.
  'daemon.backup',
] as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[number];
