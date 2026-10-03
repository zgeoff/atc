/**
 * The request features a daemon announces in its `daemon.hello` answer. A
 * daemon from before the list existed announces none, so a client that
 * outlives an upgrade sees exactly what the running daemon serves.
 */
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

  // `session.forget` exists, and a kill of a session asleep on a target that
  // can destroy its host answers `confirmation_required`.
  'session.forget',

  // `session.submit` exists.
  'session.submit',

  // `report.get` exists.
  'report.get',

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
] as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[number];
