import { AtcError } from '@atcx/contract/light';

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
  if (!(error instanceof AtcError)) {
    throw error;
  }

  return {
    code: error.code,
    message: error.message,
    data: Object.keys(error.data).length === 0 ? null : error.data,
  };
}
