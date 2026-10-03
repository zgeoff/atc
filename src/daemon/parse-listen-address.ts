import { isAllowedListenHost } from './is-allowed-listen-host';

type ParsedListenAddress =
  | { readonly ok: true; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly message: string };

/**
 * Parses a `--listen` value: `<host>:<port>`, with an IPv6 host in
 * brackets (`[::1]:8415`). The host must be an address a listener may bind
 * (loopback or a tailnet range) and the port a decimal from 1 to 65535.
 */
export function parseListenAddress(raw: string): ParsedListenAddress {
  const match = /^(?:\[(?<v6>[^\]]+)\]|(?<v4>[^:[\]]+)):(?<port>\d{1,5})$/.exec(raw);
  const host = match?.groups?.['v6'] ?? match?.groups?.['v4'];
  const port = Number(match?.groups?.['port']);

  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      ok: false,
      message: `--listen takes <host>:<port> with a port from 1 to 65535, not '${raw}'`,
    };
  }

  if (!isAllowedListenHost(host)) {
    return {
      ok: false,
      message: `--listen refuses '${host}': bind a loopback address or one in 100.64.0.0/10 or fd7a:115c:a1e4::/48`,
    };
  }

  return { ok: true, host, port };
}
