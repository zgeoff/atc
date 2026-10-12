import type { Database } from 'bun:sqlite';

/**
 * Returns the effect ref of the one idempotency claim a state database
 * holds, and throws when it holds none or several, so a test that expects
 * one claim never reads another's.
 */
export function getOnlyEffectRef(db: Database): string {
  const refs = db
    .query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency')
    .all()
    .map((row) => row.effect_ref);

  const [ref] = refs;

  if (refs.length !== 1 || ref === undefined) {
    throw new Error(`expected one idempotency claim, found ${JSON.stringify(refs)}`);
  }

  return ref;
}
