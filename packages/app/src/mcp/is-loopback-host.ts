/**
 * Whether a host name or address reaches only this machine: `localhost`, an
 * IPv4 address in 127.0.0.0/8, or `::1` with or without the brackets a URL
 * puts around it.
 */
export function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
