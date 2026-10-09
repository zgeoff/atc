/**
 * Asks the user service manager to restart its daemon unit. A failed
 * restart rejects with the manager's output and starts no standalone daemon.
 */
export async function restartManagedDaemon(systemctl = 'systemctl'): Promise<void> {
  const proc = Bun.spawn([systemctl, '--user', 'restart', 'atc-daemon.service'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  if (code !== 0) {
    throw new Error(`systemctl --user restart atc-daemon.service failed: ${stderr.trim()}`);
  }
}
