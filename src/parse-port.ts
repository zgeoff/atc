export type ParsedPort =
  | { readonly ok: true; readonly port: number }
  | { readonly ok: false; readonly message: string };

/**
 * Parses a `--port` value: plain decimal digits naming a port from 1 to
 * 65535. Signs, decimals, hex, exponents, and surrounding whitespace are all
 * refused rather than coerced.
 */
export function parsePort(raw: string): ParsedPort {
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, message: `--port takes a port from 1 to 65535, not '${raw}'` };
  }

  return { ok: true, port };
}
