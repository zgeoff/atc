import { buildATCBridgeFiles } from './build-atc-bridge-files';

const GUEST_BRIDGE_FOLDER = 'atc-bridge';

export function buildGuestBridgeFiles(
  argv: readonly string[],
  writtenAt?: number,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(buildATCBridgeFiles(argv, writtenAt)).map(([path, content]) => [
      `${GUEST_BRIDGE_FOLDER}/${path}`,
      content,
    ]),
  );
}
