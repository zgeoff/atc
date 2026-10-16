import type { ListenOptions } from './listen-options';

/**
 * The refused start for a TCP listener whose bind failed, holding the
 * address and the bind error's code, such as EADDRINUSE for a port another
 * socket holds.
 */
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
