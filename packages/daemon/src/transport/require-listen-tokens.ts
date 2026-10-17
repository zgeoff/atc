import { loadListenerTokens } from '@atc/config';
import { formatListenRefusal, isAllowedListenHost } from '@atc/config/host';
import type { ListenOptions } from './listen-options';

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
