import type { Database } from 'bun:sqlite';

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
