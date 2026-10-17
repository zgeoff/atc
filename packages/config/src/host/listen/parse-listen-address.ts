import { formatListenRefusal } from './format-listen-refusal';
import { isAllowedListenHost } from './is-allowed-listen-host';

type ParsedListenAddress =
  | { readonly ok: true; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly message: string };

export function parseListenAddress(raw: string): ParsedListenAddress {
  const match = /^(?:\[(?<v6>[^\]]+)\]|(?<v4>[^:[\]]+)):(?<port>\d{1,5})$/u.exec(raw);
  const host = match?.groups?.['v6'] ?? match?.groups?.['v4'];
  const port = Number(match?.groups?.['port']);

  if (host === undefined || !Number.isInteger(port) || port < 0 || port > 65_535) {
    return {
      ok: false,
      message: `--listen takes <host>:<port> with a port from 0 to 65535, not '${raw}'`,
    };
  }

  if (!isAllowedListenHost(host)) {
    return { ok: false, message: formatListenRefusal(host) };
  }

  return { ok: true, host, port };
}
