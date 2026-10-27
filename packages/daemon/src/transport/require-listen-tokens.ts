import { loadListenerTokens } from '@atc/config';
import type { TokenFileAccess } from '@atc/config';
import { formatListenRefusal, isAllowedListenHost } from '@atc/config/host';
import type { ListenOptions } from './listen-options';

export function requireListenTokens(
  listen: Pick<ListenOptions, 'host' | 'tokenFile'>,
  access: TokenFileAccess,
): readonly string[] {
  if (!isAllowedListenHost(listen.host)) {
    throw Object.assign(new Error(`atc daemon: ${formatListenRefusal(listen.host)}`), {
      code: 'listen_refused',
    });
  }

  const loaded = loadListenerTokens(listen.tokenFile, access);

  if (!loaded.ok) {
    throw Object.assign(new Error(`atc daemon: --token-file: ${loaded.reason}`), {
      code: 'listen_refused',
    });
  }

  return loaded.tokens;
}
