import { loadListenerTokens } from '@atc/config';
import { formatListenRefusal, isAllowedListenHost } from '@atc/config/host';
import type { ListenOptions } from './listen-options';

/**
 * The tokens the TCP listener starts with. Throws, with the code a refused
 * start carries, for an address outside the allowed ranges or a token file
 * that fails to load, so the daemon never starts with a listener that
 * takes no token or binds where it must not.
 */
export function requireListenTokens(
  listen: Pick<ListenOptions, 'host' | 'tokenFile'>,
): readonly string[] {
  if (!isAllowedListenHost(listen.host)) {
    throw Object.assign(new Error(`atc daemon: ${formatListenRefusal(listen.host)}`), {
      code: 'listen_refused',
    });
  }

  const loaded = loadListenerTokens(listen.tokenFile);

  if (!loaded.ok) {
    throw Object.assign(new Error(`atc daemon: --token-file: ${loaded.reason}`), {
      code: 'listen_refused',
    });
  }

  return loaded.tokens;
}
