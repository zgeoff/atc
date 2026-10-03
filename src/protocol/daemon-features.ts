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
] as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[number];
