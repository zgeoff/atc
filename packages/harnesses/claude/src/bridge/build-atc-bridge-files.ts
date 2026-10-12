import { ATC_BRIDGE_FILES } from './atc-bridge-files';

/**
 * The files of the atc-bridge mod, keyed by their path inside the mod's
 * folder, with the atc command the mod runs rendered from `argv`.
 */
export function buildATCBridgeFiles(argv: readonly string[]): Readonly<Record<string, string>> {
  return { ...ATC_BRIDGE_FILES, 'hooks/atc-cli.ts': renderATCCLIModule(argv) };
}

function renderATCCLIModule(argv: readonly string[]): string {
  return `export const ATC_CLI: readonly string[] = ${JSON.stringify(argv)};\n`;
}
