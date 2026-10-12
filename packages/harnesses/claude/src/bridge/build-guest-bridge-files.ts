import { buildATCBridgeFiles } from './build-atc-bridge-files';

// The folder inside a session's guest folder that holds its copy of the mod.
const GUEST_BRIDGE_FOLDER = 'atc-bridge';

/**
 * The atc-bridge mod's files for a session on a remote host, keyed by
 * their path inside the session's guest folder, running the atc inside
 * that host that `argv` runs.
 */
export function buildGuestBridgeFiles(argv: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(buildATCBridgeFiles(argv)).map(([path, content]) => [
      `${GUEST_BRIDGE_FOLDER}/${path}`,
      content,
    ]),
  );
}
