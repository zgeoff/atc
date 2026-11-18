// The headers of a peer request that carry the principal it acts as, and
// the name of that principal, which labels a message the request sends.
export const PRINCIPAL_HEADERS = { as: 'x-atc-as', asName: 'x-atc-as-name' } as const;
