import type { ListenOptions } from './listen-options';

export function buildBindRefusal(
  listen: Pick<ListenOptions, 'host' | 'port'>,
  error: unknown,
): Error {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : null;

  const address = listen.host.includes(':')
    ? `[${listen.host}]:${listen.port}`
    : `${listen.host}:${listen.port}`;

  const reason = typeof code === 'string' ? code : String(error);

  return Object.assign(new Error(`atc daemon: --listen cannot bind ${address} (${reason})`), {
    code: 'listen_refused',
  });
}
