import { buildPayloadHash } from './build-payload-hash';

// The from a daemon that read one stored for a request that gave none.
const DEFAULT_FROM = 'unknown';

/**
 * The hashes a `session.message` payload had under a daemon that read a
 * caller-given `from` and hashed it with the payload, one for each sender
 * name an older client could have sent for this caller: the `from` the
 * request holds, else the default that daemon filled in, and each name
 * given. A key stored under one of them replays as under the current hash,
 * so a retry across an upgrade answers instead of conflicting. The names
 * only match a stored hash; none of them labels a message.
 */
export function buildLegacyMessageHashes(
  params: Readonly<Record<string, unknown>>,
  rawFrom: unknown,
  names: readonly (string | null | undefined)[],
): string[] {
  const given = typeof rawFrom === 'string' && rawFrom !== '' ? rawFrom : DEFAULT_FROM;

  const froms = new Set(
    [given, ...names].filter((name): name is string => typeof name === 'string' && name !== ''),
  );

  return [...froms].map((from) => buildPayloadHash({ ...params, from }));
}
