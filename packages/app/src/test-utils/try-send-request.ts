import { DaemonError } from '../protocol/daemon-error';

/**
 * Sends a request and returns its answer as plain data, `{ ok }` or, when
 * the daemon refuses it, `{ error: { code, message, data } }`, with every
 * occurrence of `id` replaced by `<id>`, so the answers to the same request
 * for two ids compare whole: a refusal for a session a client may not see
 * and one for a session that never existed must read alike. A failure that
 * is not a daemon refusal rejects as it is.
 */
export async function trySendRequest(
  send: () => Promise<Readonly<Record<string, unknown>>>,
  id: string,
): Promise<unknown> {
  const answer = await send().then(
    (ok) => ({ ok }),
    (error: unknown) => ({ error: toRefusal(error) }),
  );

  return JSON.parse(JSON.stringify(answer).replaceAll(id, '<id>'));
}

function toRefusal(error: unknown): unknown {
  if (!(error instanceof DaemonError)) {
    throw error;
  }

  return { code: error.code, message: error.message, data: error.data ?? null };
}
