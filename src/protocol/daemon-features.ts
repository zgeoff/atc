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
] as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[number];
