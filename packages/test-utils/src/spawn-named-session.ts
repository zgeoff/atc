import { isRecord } from '@atc/core';

type SendRequest = (
  m: string,
  p?: Readonly<Record<string, unknown>>,
) => Promise<Readonly<Record<string, unknown>>>;

export async function spawnNamedSession(
  send: SendRequest,
  name: string,
  cwd: string,
): Promise<string> {
  const ok = await send('session.spawn', { cwd, name, cols: 80, rows: 24 });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  return spawned['id'];
}
