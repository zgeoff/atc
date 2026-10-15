import type { RemoteDaemon } from '@atc/config/collect-remote-daemons';
import type { Config } from '@atc/config/config';

type ResolvedRemoteDaemon =
  | { readonly ok: true; readonly daemon: RemoteDaemon }
  | { readonly ok: false; readonly message: string };

/**
 * The daemon that `--daemon <name>` selects from the config's `daemons`
 * map, or a message that says why none can be used: the entry broke a
 * rule, or the map holds no entry of that name. `file` is the config path
 * the message mentions.
 */
export function resolveRemoteDaemon(
  config: Pick<Config, 'daemons' | 'daemonErrors'>,
  name: string,
  file: string,
): ResolvedRemoteDaemon {
  const daemon = config.daemons.get(name);

  if (daemon !== undefined) {
    return { ok: true, daemon };
  }

  const prefix = `daemons.${name}: `;
  const problem = config.daemonErrors.find((error) => error.startsWith(prefix));

  if (problem !== undefined) {
    return {
      ok: false,
      message: `the daemons.${name} entry of ${file} cannot be used: ${problem.slice(prefix.length)}. The TUI did not fall back to the local daemon.`,
    };
  }

  const names = [...config.daemons.keys()];
  const held = names.length === 0 ? 'it holds none' : `it holds ${names.join(', ')}`;

  return {
    ok: false,
    message: `the daemons map of ${file} holds no daemon '${name}'; ${held}. The TUI did not fall back to the local daemon.`,
  };
}
