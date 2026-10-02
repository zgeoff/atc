import type { HTTPServerContext } from './types';

/**
 * The id of the live owner session a request's cookie header carries, or
 * null when it carries none, or one that is unsigned, expired, or deleted.
 */
export async function findOwnerSessionID(
  ctx: HTTPServerContext,
  cookie: string | null,
): Promise<string | null> {
  if (cookie === null || cookie === '') {
    return null;
  }

  const found = await ctx.store.auth.api.getSession({ headers: new Headers({ cookie }) });

  return found?.session.id ?? null;
}
