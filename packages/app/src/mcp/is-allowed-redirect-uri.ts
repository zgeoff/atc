import { isLoopbackHost } from './is-loopback-host';

export function isAllowedRedirectURI(raw: string): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.hash !== '' || url.username !== '' || url.password !== '') {
    return false;
  }

  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}
