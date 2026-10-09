import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from './resolve-home-dir';

/**
 * Finds an installed daemon user unit without a connection to the service
 * manager. An installed or masked unit keeps ownership while it is stopped.
 */
export function readManagedDaemonUnit(
  directories: readonly string[] = buildUserUnitDirectories(process.env, resolveHomeDir()),
): string | null {
  for (const directory of directories) {
    const path = join(directory, 'atc-daemon.service');

    try {
      lstatSync(path);

      return path;
    } catch {
      // A directory without this unit contributes no ownership signal.
    }
  }

  return null;
}

function buildUserUnitDirectories(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string[] {
  const config = pickDirectory(env['XDG_CONFIG_HOME'], join(home, '.config'));
  const data = pickDirectory(env['XDG_DATA_HOME'], join(home, '.local', 'share'));
  const runtime = env['XDG_RUNTIME_DIR'];

  const defaults = [
    join(config, 'systemd', 'user.control'),
    join(config, 'systemd', 'user'),
    join(home, '.config', 'systemd', 'user'),
    ...pickDirectory(env['XDG_CONFIG_DIRS'], '/etc/xdg')
      .split(':')
      .map((path) => join(path, 'systemd', 'user')),
    '/etc/systemd/user',
    '/run/systemd/user',
    ...(runtime === undefined
      ? []
      : [
          join(runtime, 'systemd', 'user.control'),
          join(runtime, 'systemd', 'transient'),
          join(runtime, 'systemd', 'generator.early'),
          join(runtime, 'systemd', 'user'),
          join(runtime, 'systemd', 'generator'),
          join(runtime, 'systemd', 'generator.late'),
        ]),
    join(data, 'systemd', 'user'),
    ...pickDirectory(env['XDG_DATA_DIRS'], '/usr/local/share:/usr/share')
      .split(':')
      .map((path) => join(path, 'systemd', 'user')),
    '/usr/local/lib/systemd/user',
    '/usr/lib/systemd/user',
  ];

  const override = env['SYSTEMD_UNIT_PATH'];

  return override === undefined
    ? defaults
    : [
        ...override.split(':').filter((path) => path !== ''),
        ...(override.endsWith(':') ? defaults : []),
      ];
}

function pickDirectory(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}
