// A loopback port the kernel handed out and this call then freed, so nothing listens on it.
export function takeFreePort(): number {
  const freed = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = freed.port;

  freed.stop(true);

  return port;
}
