interface IdempotencyKeyReader {
  readonly readIdempotencyKeys: () => Promise<readonly { readonly effectRef: string }[]>;
}

export async function readOnlyEffectRef(store: IdempotencyKeyReader): Promise<string> {
  const keys = await store.readIdempotencyKeys();

  const refs = keys.map((key) => key.effectRef);
  const [ref] = refs;

  if (refs.length !== 1 || ref === undefined) {
    throw new Error(`expected one idempotency claim, found ${JSON.stringify(refs)}`);
  }

  return ref;
}
