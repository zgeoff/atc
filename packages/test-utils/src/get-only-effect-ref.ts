import type { Database } from 'bun:sqlite';
import { z } from 'zod';

const EFFECT_REF_ROWS_SCHEMA = z.array(z.object({ effect_ref: z.string() }));

export function getOnlyEffectRef(db: Database): string {
  const refs = EFFECT_REF_ROWS_SCHEMA.parse(
    db.query('SELECT effect_ref FROM idempotency').all(),
  ).map((row) => row.effect_ref);

  const [ref] = refs;

  if (refs.length !== 1 || ref === undefined) {
    throw new Error(`expected one idempotency claim, found ${JSON.stringify(refs)}`);
  }

  return ref;
}
