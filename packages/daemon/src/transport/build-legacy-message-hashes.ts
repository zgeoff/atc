import { buildPayloadHash } from './build-payload-hash';

// The from a daemon that read one stored for a request that gave none.
const DEFAULT_FROM = 'unknown';

// a key an older daemon stored hashed a caller-given `from` with the payload; matching any
// of these hashes lets a retry across an upgrade replay instead of conflicting. The names
// only match a stored hash and never label a message.
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
