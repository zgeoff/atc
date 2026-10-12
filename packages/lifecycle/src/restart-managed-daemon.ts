import { runCommand } from './run-command';

/**
 * Asks the user service manager to restart its daemon unit. A failed
 * restart rejects with the manager's output and starts no standalone daemon.
 */
export async function restartManagedDaemon(systemctl = 'systemctl'): Promise<void> {
  const restarted = await runCommand([systemctl, '--user', 'restart', 'atc-daemon.service']);

  if (restarted.code !== 0) {
    throw new Error(`systemctl --user restart atc-daemon.service failed: ${restarted.stderr}`);
  }
}
