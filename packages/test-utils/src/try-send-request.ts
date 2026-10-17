import { DaemonError } from '@atc/protocol/wire';

export async function trySendRequest(
  send: () => Promise<Readonly<Record<string, unknown>>>,
  id: string,
): Promise<unknown> {
  const answer = await send().then(
    (ok) => ({ ok }),
    (error: unknown) => ({ error: toRefusal(error) }),
  );

  // The answers for two ids then compare whole, so a refusal for a session a
  // client may not see can be checked to read like one for a session that never
  // existed.
  return JSON.parse(JSON.stringify(answer).replaceAll(id, '<id>'));
}

function toRefusal(error: unknown): unknown {
  if (!(error instanceof DaemonError)) {
    throw error;
  }

  return { code: error.code, message: error.message, data: error.data ?? null };
}
