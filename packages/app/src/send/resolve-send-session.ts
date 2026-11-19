export interface ListedSession {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

export type SessionMatch =
  | { readonly kind: 'found'; readonly id: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ListedSession[] };

export function resolveSendSession(
  sessions: readonly ListedSession[],
  argument: string,
): SessionMatch {
  const byID = sessions.find((session) => session.id === argument);

  if (byID !== undefined) {
    return { kind: 'found', id: byID.id };
  }

  const named = sessions.filter((session) => session.name === argument);
  const [only] = named;

  if (only === undefined) {
    return { kind: 'missing' };
  }

  return named.length === 1
    ? { kind: 'found', id: only.id }
    : { kind: 'ambiguous', candidates: named };
}
