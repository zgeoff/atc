import { buildATCBridgeFiles } from './build-atc-bridge-files';

// The folder inside a session's guest folder that holds its copy of the mod.
const GUEST_BRIDGE_FOLDER = 'atc-bridge';

export function buildGuestBridgeFiles(argv: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(buildATCBridgeFiles(argv)).map(([path, content]) => [
      `${GUEST_BRIDGE_FOLDER}/${path}`,
      content,
    ]),
  );
}
