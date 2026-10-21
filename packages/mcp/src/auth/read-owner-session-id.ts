import type { HTTPServerContext } from './types';

export async function readOwnerSessionID(
  ctx: HTTPServerContext,
  cookie: string | null,
): Promise<string | null> {
  if (cookie === null || cookie === '') {
    return null;
  }

  const found = await ctx.store.auth.api.getSession({ headers: new Headers({ cookie }) });

  return found?.session.id ?? null;
}
